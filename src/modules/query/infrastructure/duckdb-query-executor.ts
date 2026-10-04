import { lstat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import {
  DuckDBDateValue,
  DuckDBDecimalType,
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  type DuckDBConnection,
  type DuckDBResultReader,
  type DuckDBValue,
} from "@duckdb/node-api";
import { withAnalyticalMaterial } from "../../dataset/application/resolve-analytical-source.ts";
import type { AnalyticalMaterialIdentity } from "../../dataset/domain/analytical-source.ts";
import type {
  ExecuteCompiledQueryResult,
  QueryExecutionOptions,
} from "../application/execute-compiled-query.ts";
import type {
  CompilationFailureCode,
  CompiledParameter,
  CompiledQuery,
  CompiledStatement,
  CompiledValidationCommand,
} from "../domain/compiled-query.ts";
import type {
  QueryResult,
  QueryResultColumn,
  QueryResultRow,
  QueryValue,
} from "../domain/query-result.ts";
import type {
  OutputDescriptor,
  PhysicalValueType,
} from "../domain/physical-query-plan.ts";
import { isTrustedCompiledQuery } from "./duckdb-query-compiler.ts";

export const QUERY_TIMEOUT_MS = 10_000;
export const MAX_RESULT_ROWS = 500;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

type StopReason = "QUERY_TIMEOUT" | "QUERY_CANCELLED";

class ExecutionStopped extends Error {}
class InconsistentResult extends Error {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function sameIdentity(
  expected: AnalyticalMaterialIdentity,
  actual: BigIntStats,
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.device &&
    actual.ino === expected.inode &&
    actual.size === expected.sizeBytes &&
    actual.mtimeNs === expected.modifiedTimeNs
  );
}

async function materialMatches(
  filename: string,
  expected: AnalyticalMaterialIdentity,
): Promise<boolean> {
  try {
    return sameIdentity(expected, await lstat(filename, { bigint: true }));
  } catch {
    return false;
  }
}

function bound(parameters: readonly CompiledParameter[], filename: string) {
  return parameters.map((parameter) =>
    parameter.kind === "MATERIAL_PATH" ? filename : parameter.value,
  );
}

export function structuredEngineFailure(
  statement: CompiledStatement,
  error: unknown,
): CompilationFailureCode | undefined {
  if (!(error instanceof Error)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(error.message);
  } catch {
    return undefined;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof (payload as { exception_type?: unknown }).exception_type !== "string"
  )
    return undefined;
  const exceptionType = (payload as { exception_type: string }).exception_type;
  return statement.engineErrorMappings.find(
    (mapping) => mapping.exceptionType === exceptionType,
  )?.failureCode;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function dateText(value: DuckDBDateValue): string {
  if (!value.isFinite) throw new InconsistentResult();
  const { year, month, day } = value.toParts();
  if (year < 0 || year > 9999) throw new InconsistentResult();
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function timestampText(
  value: DuckDBTimestampValue | DuckDBTimestampTZValue,
  instant: boolean,
): string {
  if (!value.isFinite) throw new InconsistentResult();
  const { date, time } = value.toParts();
  if (date.year < 0 || date.year > 9999) throw new InconsistentResult();
  const fraction =
    time.micros === 0 ? "" : `.${pad(time.micros, 6).replace(/0+$/, "")}`;
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}T${pad(time.hour)}:${pad(time.min)}:${pad(time.sec)}${fraction}${instant ? "Z" : ""}`;
}

function decimalText(value: DuckDBDecimalValue): string {
  const negative = value.value < BigInt(0);
  const digits = (negative ? -value.value : value.value).toString();
  if (value.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(value.scale + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -value.scale)}.${padded.slice(-value.scale)}`;
}

export function serializeQueryValue(
  value: DuckDBValue,
  type: OutputDescriptor["semanticType"],
): QueryValue {
  if (value === null) return { type: "NULL" };
  switch (type.kind) {
    case "STRING":
      if (typeof value !== "string" || value.includes("\0"))
        throw new InconsistentResult();
      return { type: "STRING", value };
    case "BOOLEAN":
      if (typeof value !== "boolean") throw new InconsistentResult();
      return { type: "BOOLEAN", value };
    case "INTEGER":
      if (typeof value !== "bigint") throw new InconsistentResult();
      return { type: "INTEGER", value: value.toString() };
    case "DECIMAL":
      if (
        !(value instanceof DuckDBDecimalValue) ||
        value.width !== type.precision ||
        value.scale !== type.scale
      )
        throw new InconsistentResult();
      return { type: "DECIMAL", value: decimalText(value) };
    case "NUMBER":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new InconsistentResult();
      return {
        type: "NUMBER",
        value: Object.is(value, -0) ? "0" : String(value),
      };
    case "DATE":
      if (!(value instanceof DuckDBDateValue)) throw new InconsistentResult();
      return { type: "DATE", value: dateText(value) };
    case "DATETIME":
      if (!(value instanceof DuckDBTimestampValue))
        throw new InconsistentResult();
      return { type: "DATETIME", value: timestampText(value, false) };
    case "INSTANT":
      if (!(value instanceof DuckDBTimestampTZValue))
        throw new InconsistentResult();
      return { type: "INSTANT", value: timestampText(value, true) };
  }
}

function expectedTypeId(type: PhysicalValueType): DuckDBTypeId {
  switch (type.kind) {
    case "TEXT":
      return DuckDBTypeId.VARCHAR;
    case "BOOLEAN":
      return DuckDBTypeId.BOOLEAN;
    case "HUGEINT":
      return DuckDBTypeId.HUGEINT;
    case "BIGINT":
      return DuckDBTypeId.BIGINT;
    case "DOUBLE":
      return DuckDBTypeId.DOUBLE;
    case "DATE":
      return DuckDBTypeId.DATE;
    case "TIMESTAMP":
      return DuckDBTypeId.TIMESTAMP;
    case "TIMESTAMPTZ":
      return DuckDBTypeId.TIMESTAMP_TZ;
    case "DECIMAL":
      return DuckDBTypeId.DECIMAL;
  }
}

function validateOutput(
  reader: DuckDBResultReader,
  outputs: readonly OutputDescriptor[],
) {
  if (reader.columnCount !== outputs.length) throw new InconsistentResult();
  outputs.forEach((output, index) => {
    if (
      output.outputIndex !== index ||
      reader.columnName(index) !== `o${index}` ||
      reader.columnTypeId(index) !== expectedTypeId(output.physicalType)
    )
      throw new InconsistentResult();
    if (output.physicalType.kind === "DECIMAL") {
      const actual = reader.columnType(index);
      if (
        !(actual instanceof DuckDBDecimalType) ||
        actual.width !== output.physicalType.precision ||
        actual.scale !== output.physicalType.scale
      )
        throw new InconsistentResult();
    }
  });
}

function resultColumns(
  outputs: readonly OutputDescriptor[],
): QueryResultColumn[] {
  return outputs.map((output) => ({
    key:
      output.semanticKey.kind === "FIELD"
        ? output.semanticKey.fieldKey
        : output.semanticKey.metricKey,
    label: output.label,
    role: output.role,
    semanticType:
      output.semanticType.kind === "DECIMAL"
        ? { ...output.semanticType }
        : { kind: output.semanticType.kind },
  }));
}

function readResult(
  reader: DuckDBResultReader,
  outputs: readonly OutputDescriptor[],
): QueryResult | "RESULT_LIMIT_EXCEEDED" | "RESULT_SIZE_LIMIT_EXCEEDED" {
  validateOutput(reader, outputs);
  if (reader.currentRowCount > MAX_RESULT_ROWS) return "RESULT_LIMIT_EXCEEDED";
  if (!reader.done) throw new InconsistentResult();

  const columns = resultColumns(outputs);
  const rows: QueryResultRow[] = [];
  let totalBytes = utf8Bytes({ columns, rows: [] });
  for (let rowIndex = 0; rowIndex < reader.currentRowCount; rowIndex += 1) {
    const row: QueryValue[] = [];
    let rowBytes = 2;
    for (let columnIndex = 0; columnIndex < outputs.length; columnIndex += 1) {
      const value = serializeQueryValue(
        reader.value(columnIndex, rowIndex),
        outputs[columnIndex].semanticType,
      );
      rowBytes += utf8Bytes(value) + (columnIndex === 0 ? 0 : 1);
      if (totalBytes + (rowIndex === 0 ? 0 : 1) + rowBytes > MAX_RESULT_BYTES)
        return "RESULT_SIZE_LIMIT_EXCEEDED";
      row.push(value);
    }
    totalBytes += (rowIndex === 0 ? 0 : 1) + rowBytes;
    rows.push(row);
  }
  return { columns, rows };
}

function compiledShapeValid(compiled: CompiledQuery): boolean {
  return (
    compiled.version === 1 &&
    compiled.sessionRequirements.timeZone === "UTC" &&
    compiled.lifecycle.connection === "DEDICATED_PER_EXECUTION" &&
    compiled.lifecycle.temporaryObject === "__t018_source" &&
    compiled.lifecycle.cleanup === "CLOSE_CONNECTION"
  );
}

type Control = {
  reason?: StopReason;
  connection?: DuckDBConnection;
  stop(reason: StopReason): void;
  check(): void;
};

function executionControl(): Control {
  return {
    stop(reason) {
      if (this.reason) return;
      this.reason = reason;
      this.connection?.interrupt();
    },
    check() {
      if (this.reason) throw new ExecutionStopped();
    },
  };
}

async function runStatement(
  connection: DuckDBConnection,
  statement: CompiledStatement,
  filename: string,
  control: Control,
): Promise<DuckDBResultReader> {
  control.check();
  try {
    const reader = await connection.runAndReadAll(
      statement.sql,
      bound(statement.parameters, filename),
    );
    control.check();
    return reader;
  } catch (error) {
    control.check();
    throw error;
  }
}

async function validationFailure(
  connection: DuckDBConnection,
  command: CompiledValidationCommand,
  filename: string,
  control: Control,
): Promise<CompilationFailureCode | undefined> {
  let reader: DuckDBResultReader;
  try {
    reader = await runStatement(
      connection,
      command.statement,
      filename,
      control,
    );
  } catch (error) {
    const failure = structuredEngineFailure(command.statement, error);
    if (failure) return failure;
    throw error;
  }
  if (reader.currentRowCount !== 1 || reader.columnCount === 0)
    throw new InconsistentResult();
  if (command.result.kind === "BOOLEAN") {
    if (
      reader.columnCount !== 1 ||
      reader.columnName(0) !== command.result.resultAlias ||
      reader.columnTypeId(0) !== DuckDBTypeId.BOOLEAN
    )
      throw new InconsistentResult();
    const value = reader.value(0, 0);
    if (typeof value !== "boolean") throw new InconsistentResult();
    return value ? undefined : command.result.failureCode;
  }
  if (reader.columnCount !== command.result.checks.length)
    throw new InconsistentResult();
  for (let index = 0; index < command.result.checks.length; index += 1) {
    const check = command.result.checks[index];
    if (
      reader.columnName(index) !== check.resultAlias ||
      reader.columnTypeId(index) !== DuckDBTypeId.BIGINT
    )
      throw new InconsistentResult();
    const count = reader.value(index, 0);
    if (typeof count !== "bigint" || count < BigInt(0))
      throw new InconsistentResult();
    if (count > BigInt(0)) return check.failureCode;
  }
  return undefined;
}

async function executeLifecycle(
  connection: DuckDBConnection,
  compiled: CompiledQuery,
  filename: string,
  control: Control,
): Promise<ExecuteCompiledQueryResult> {
  for (const command of compiled.sourceValidations) {
    const failure = await validationFailure(
      connection,
      command,
      filename,
      control,
    );
    if (failure) return { outcome: failure };
  }
  try {
    await runStatement(
      connection,
      compiled.preparation.statement,
      filename,
      control,
    );
  } catch (error) {
    const failure = structuredEngineFailure(
      compiled.preparation.statement,
      error,
    );
    if (failure) return { outcome: failure };
    throw error;
  }
  for (const command of compiled.validations) {
    const failure = await validationFailure(
      connection,
      command,
      filename,
      control,
    );
    if (failure) return { outcome: failure };
  }

  control.check();
  let reader: DuckDBResultReader;
  try {
    reader = await connection.startStreamThenReadUntil(
      compiled.query.sql,
      MAX_RESULT_ROWS + 1,
      bound(compiled.query.parameters, filename),
    );
    control.check();
  } catch (error) {
    control.check();
    const failure = structuredEngineFailure(compiled.query, error);
    if (failure) return { outcome: failure };
    throw error;
  }
  const result = readResult(reader, compiled.outputs);
  if (typeof result === "string") {
    if (result === "RESULT_LIMIT_EXCEEDED") connection.interrupt();
    return { outcome: result };
  }
  return { outcome: "SUCCESS", result: deepFreeze(result) };
}

async function executeWithMaterial(
  compiled: CompiledQuery,
  filename: string,
  options: QueryExecutionOptions,
): Promise<ExecuteCompiledQueryResult> {
  if (!(await materialMatches(filename, compiled.materialIdentity)))
    return { outcome: "SOURCE_INTEGRITY_FAILED" };
  if (options.signal?.aborted) return { outcome: "QUERY_CANCELLED" };

  const control = executionControl();
  const onAbort = () => control.stop("QUERY_CANCELLED");
  const timer = setTimeout(
    () => control.stop("QUERY_TIMEOUT"),
    QUERY_TIMEOUT_MS,
  );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) control.stop("QUERY_CANCELLED");
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    instance = await DuckDBInstance.create(":memory:", {
      threads: "2",
      memory_limit: "256MB",
      max_temp_directory_size: "0B",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
    });
    control.check();
    connection = await instance.connect();
    control.connection = connection;
    control.check();
    await connection.run("SET TimeZone='UTC'");
    control.check();
    await connection.run("SET errors_as_json=true");
    control.check();
    const result = await executeLifecycle(
      connection,
      compiled,
      filename,
      control,
    );
    control.check();
    if (!(await materialMatches(filename, compiled.materialIdentity)))
      return { outcome: "SOURCE_INTEGRITY_FAILED" };
    control.check();
    return result;
  } catch (error) {
    if (control.reason) return { outcome: control.reason };
    if (error instanceof InconsistentResult)
      return { outcome: "INCONSISTENT_QUERY_RESULT" };
    return { outcome: "QUERY_OPERATIONAL_FAILURE" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    connection?.closeSync();
    instance?.closeSync();
  }
}

export async function executeDuckDBQuery(
  compiled: CompiledQuery,
  options: QueryExecutionOptions,
): Promise<ExecuteCompiledQueryResult> {
  if (options.signal?.aborted) return { outcome: "QUERY_CANCELLED" };
  if (!isTrustedCompiledQuery(compiled) || !compiledShapeValid(compiled))
    return { outcome: "INCONSISTENT_COMPILED_QUERY" };
  try {
    return await withAnalyticalMaterial(compiled.material, (filename) =>
      executeWithMaterial(compiled, filename, options),
    );
  } catch {
    return { outcome: "SOURCE_INTEGRITY_FAILED" };
  }
}
