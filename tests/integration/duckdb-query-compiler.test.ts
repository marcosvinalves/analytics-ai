import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AnalyticalMaterialHandle } from "../../src/modules/dataset/domain/analytical-source.ts";
import type {
  CompilationFailureCode,
  CompiledQuery,
  CompiledStatement,
  CompiledValidationCommand,
} from "../../src/modules/query/domain/compiled-query.ts";
import type {
  PhysicalQueryPlan,
  PhysicalValueType,
  PlannedSourceField,
  SourceConversionPolicy,
} from "../../src/modules/query/domain/physical-query-plan.ts";
import { compilePhysicalQuery } from "../../src/modules/query/infrastructure/duckdb-query-compiler.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const material = Object.freeze({}) as AnalyticalMaterialHandle;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "t018-compiler-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function sourceField(
  columnIndex: number,
  semanticType: SemanticType,
  resultType: PhysicalValueType,
  conversion: SourceConversionPolicy,
): PlannedSourceField {
  return {
    fieldKey: `field-${columnIndex}`,
    columnIndex,
    semanticType,
    persistedPhysicalType:
      resultType.kind === "HUGEINT"
        ? { family: "INTEGER", name: "BIGINT", decimalDigits: 19 }
        : resultType.kind === "DOUBLE"
          ? { family: "NUMBER", name: "DOUBLE" }
          : resultType.kind === "DECIMAL"
            ? { family: "NUMBER", name: "DOUBLE" }
            : resultType.kind === "DATE"
              ? { family: "DATE", name: "DATE" }
              : resultType.kind === "TIMESTAMP"
                ? { family: "DATETIME", name: "TIMESTAMP" }
                : resultType.kind === "TIMESTAMPTZ"
                  ? {
                      family: "INSTANT",
                      name: "TIMESTAMP WITH TIME ZONE",
                    }
                  : { family: "STRING", name: "VARCHAR" },
    compatibility: "EXECUTABLE_SAFE",
    conversion,
    resultType,
  };
}

function source(
  columns: string[],
  expectedRowCount: number,
): PhysicalQueryPlan["source"] {
  return {
    kind: "CSV",
    material,
    materialIdentity: {
      device: BigInt(1),
      inode: BigInt(2),
      sizeBytes: BigInt(1),
      modifiedTimeNs: BigInt(3),
    },
    expectedSizeBytes: BigInt(1),
    expectedRowCount: BigInt(expectedRowCount),
    columns: columns.map((physicalName, index) => ({
      physicalName,
      ordinalPosition: index + 1,
    })),
    readMode: "TEXT",
    dialect: {
      encoding: "UTF-8",
      delimiter: ",",
      quote: '"',
      escape: '"',
      header: true,
      strict: true,
      emptyField: "NULL",
      quotedEmptyField: "NULL",
    },
    schemaValidation: {
      headerRequired: true,
      exactColumnCount: true,
      exactNamesAndOrder: true,
      duplicateNames: "ERROR",
      invalidRowShape: "ERROR",
      expectedRowCount: BigInt(expectedRowCount),
    },
  };
}

function countPlan(
  columns: string[],
  fields: PlannedSourceField[],
  expectedRowCount = 1,
): PhysicalQueryPlan {
  return {
    version: 1,
    context: {
      semanticModelId: "model",
      semanticModelRevisionId: "revision",
      datasetId: "dataset",
      datasetVersionId: "version",
    },
    source: source(columns, expectedRowCount),
    sourceFields: fields,
    dimensions: [],
    metrics: [
      {
        outputIndex: 0,
        semanticType: { kind: "INTEGER" },
        expression: {
          kind: "AGGREGATE",
          op: "COUNT",
          expression: {
            kind: "SOURCE_FIELD",
            sourceFieldIndex: 0,
            resultType: fields[0].resultType,
          },
          resultType: { kind: "BIGINT" },
          aggregationPolicy: "CARDINALITY",
          overflow: "ERROR",
          requireFiniteResult: false,
        },
      },
    ],
    filters: [],
    orderBy: [],
    output: [
      {
        outputIndex: 0,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: "count" },
        name: "count",
        label: "Count",
        semanticType: { kind: "INTEGER" },
        physicalType: { kind: "BIGINT" },
      },
    ],
  };
}

function compile(plan: PhysicalQueryPlan): CompiledQuery {
  const result = compilePhysicalQuery(plan);
  if (result.outcome !== "COMPILED") throw new Error(result.outcome);
  return result.compiledQuery;
}

function bound(statement: CompiledStatement, filename: string) {
  return statement.parameters.map((parameter) =>
    parameter.kind === "MATERIAL_PATH" ? filename : parameter.value,
  );
}

function structuredFailure(
  statement: CompiledStatement,
  error: unknown,
): CompilationFailureCode | undefined {
  let payload: { exception_type?: string };
  try {
    payload = JSON.parse(error instanceof Error ? error.message : "");
  } catch {
    return undefined;
  }
  return statement.engineErrorMappings.find(
    (mapping) => mapping.exceptionType === payload.exception_type,
  )?.failureCode;
}

async function validate(
  connection: DuckDBConnection,
  command: CompiledValidationCommand,
  filename: string,
): Promise<CompilationFailureCode | undefined> {
  let reader;
  try {
    reader = await connection.runAndReadAll(
      command.statement.sql,
      bound(command.statement, filename),
    );
  } catch (error) {
    return structuredFailure(command.statement, error);
  }
  const row = reader.getRowObjects()[0] ?? {};
  if (command.result.kind === "BOOLEAN")
    return row[command.result.resultAlias] === true
      ? undefined
      : command.result.failureCode;
  for (const check of command.result.checks) {
    const count = row[check.resultAlias];
    if (
      (typeof count === "bigint" && count > BigInt(0)) ||
      (typeof count === "number" && count > 0)
    )
      return check.failureCode;
  }
  return undefined;
}

async function execute(
  compiled: CompiledQuery,
  filename: string,
): Promise<
  | {
      outcome: "SUCCESS";
      rows: ReturnType<
        Awaited<ReturnType<DuckDBConnection["runAndReadAll"]>>["getRows"]
      >;
      type: string;
    }
  | { outcome: "FAILED"; code: CompilationFailureCode }
> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone='UTC'");
    await connection.run("SET errors_as_json=true");
    for (const command of compiled.sourceValidations) {
      const failure = await validate(connection, command, filename);
      if (failure) return { outcome: "FAILED", code: failure };
    }
    try {
      await connection.run(
        compiled.preparation.statement.sql,
        bound(compiled.preparation.statement, filename),
      );
    } catch (error) {
      const failure = structuredFailure(compiled.preparation.statement, error);
      if (failure) return { outcome: "FAILED", code: failure };
      throw error;
    }
    for (const command of compiled.validations) {
      const failure = await validate(connection, command, filename);
      if (failure) return { outcome: "FAILED", code: failure };
    }
    try {
      const reader = await connection.runAndReadAll(
        compiled.query.sql,
        bound(compiled.query, filename),
      );
      return {
        outcome: "SUCCESS",
        rows: reader.getRows(),
        type: reader.columnType(0).toString(),
      };
    } catch (error) {
      const failure = structuredFailure(compiled.query, error);
      if (failure) return { outcome: "FAILED", code: failure };
      throw error;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function csv(name: string, content: string) {
  const filename = path.join(root, name);
  await writeFile(filename, content);
  return filename;
}

const textField = (columnIndex = 0) =>
  sourceField(
    columnIndex,
    { kind: "STRING" },
    { kind: "TEXT" },
    {
      kind: "TEXT_IDENTITY",
      trim: false,
      normalizeUnicode: false,
      rejectNul: true,
      nulls: "PRESERVE",
    },
  );

test("executes the compiled exact query as DECIMAL(38,2) with independent cents ground truth", async () => {
  const quantity = sourceField(
    0,
    { kind: "INTEGER" },
    { kind: "HUGEINT" },
    {
      kind: "TEXT_TO_EXACT_INTEGER",
      fractionalValues: "ERROR",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const price = sourceField(
    1,
    { kind: "DECIMAL", precision: 18, scale: 2 },
    { kind: "DECIMAL", precision: 18, scale: 2 },
    {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: 18,
      scale: 2,
      scientificNotation: "ERROR",
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const base = countPlan(["quantity", "unit_price"], [quantity, price], 3);
  const metric: PhysicalQueryPlan["metrics"][number] = {
    outputIndex: 0,
    semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
    expression: {
      kind: "AGGREGATE",
      op: "SUM",
      aggregationPolicy: "EXACT_DECIMAL",
      overflow: "ERROR",
      requireFiniteResult: false,
      resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
      expression: {
        kind: "BINARY",
        op: "MULTIPLY",
        arithmeticPolicy: "EXACT_DECIMAL",
        overflow: "ERROR",
        requireFiniteResult: false,
        resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        left: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 0,
          resultType: { kind: "HUGEINT" },
        },
        right: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 1,
          resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
        },
      },
    },
  };
  const output: PhysicalQueryPlan["output"][number] = {
    outputIndex: 0,
    role: "METRIC",
    semanticKey: { kind: "METRIC", metricKey: "revenue" },
    name: "revenue",
    label: "Revenue",
    semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
    physicalType: { kind: "DECIMAL", precision: 38, scale: 2 },
  };
  const plan: PhysicalQueryPlan = {
    ...base,
    metrics: [metric],
    output: [output],
  };
  const rows = [
    [BigInt(2), BigInt(100000)],
    [BigInt(1), BigInt(5961)],
    [BigInt(3), null],
  ] as const;
  const expectedCents = rows.reduce(
    (sum, [quantityValue, cents]) =>
      cents === null ? sum : sum + quantityValue * cents,
    BigInt(0),
  );
  expect(expectedCents).toBe(BigInt(205961));
  const filename = await csv(
    "central ' bound.csv",
    "quantity,unit_price\n2,1000.00\n1,59.61\n3,\n",
  );
  const result = await execute(compile(plan), filename);
  expect(result.outcome).toBe("SUCCESS");
  if (result.outcome !== "SUCCESS") return;
  expect(result.type).toBe("DECIMAL(38,2)");
  expect(result.rows[0][0]).toMatchObject({
    width: 38,
    scale: 2,
    value: expectedCents,
  });
});

test("preserves quoted headers, delimiters, escaped quotes, multiline fields, BOM and NULL", async () => {
  const columns = ["na,me", 'quo"te', "multiline", "empty", "quoted_empty"];
  const filename = await csv(
    "dialect.csv",
    '\ufeff"na,me","quo""te",multiline,empty,quoted_empty\r\n"A,B","said ""hi""","line1\nline2",,""\r\n',
  );
  const result = await execute(
    compile(
      countPlan(
        columns,
        columns.map((_, index) => textField(index)),
      ),
    ),
    filename,
  );
  expect(result).toMatchObject({ outcome: "SUCCESS", type: "BIGINT" });
  if (result.outcome === "SUCCESS") expect(result.rows[0][0]).toBe(BigInt(1));
});

test.each([
  ["1.234", "SOURCE_VALUE_INVALID"],
  ["1e2", "SOURCE_VALUE_INVALID"],
  [" 1.20", "SOURCE_VALUE_INVALID"],
  ["99999999999999999.99", "NUMERIC_OVERFLOW"],
] as const)("classifies invalid DECIMAL %s", async (value, code) => {
  const field = sourceField(
    0,
    { kind: "DECIMAL", precision: 18, scale: 2 },
    { kind: "DECIMAL", precision: 18, scale: 2 },
    {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: 18,
      scale: 2,
      scientificNotation: "ERROR",
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const filename = await csv(
    `decimal-${code}-${value.length}.csv`,
    `value\n${value}\n`,
  );
  expect(
    await execute(compile(countPlan(["value"], [field])), filename),
  ).toEqual({
    outcome: "FAILED",
    code,
  });
});

test("accepts exact DECIMAL edge cases without normalization through DOUBLE", async () => {
  const field = sourceField(
    0,
    { kind: "DECIMAL", precision: 5, scale: 2 },
    { kind: "DECIMAL", precision: 5, scale: 2 },
    {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: 5,
      scale: 2,
      scientificNotation: "ERROR",
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const filename = await csv(
    "decimal-valid.csv",
    'value\n0.00\n1.2\n-1.20\n0001.20\n999.99\n""\n',
  );
  const result = await execute(
    compile(countPlan(["value"], [field], 6)),
    filename,
  );
  expect(result).toMatchObject({ outcome: "SUCCESS", type: "BIGINT" });
  if (result.outcome === "SUCCESS") expect(result.rows[0][0]).toBe(BigInt(5));
});

test("widens DECIMAL operands exactly before multiplication", async () => {
  const decimal = (columnIndex: number) =>
    sourceField(
      columnIndex,
      { kind: "DECIMAL", precision: 18, scale: 2 },
      { kind: "DECIMAL", precision: 18, scale: 2 },
      {
        kind: "TEXT_TO_EXACT_DECIMAL",
        precision: 18,
        scale: 2,
        scientificNotation: "ERROR",
        rounding: "FORBIDDEN",
        truncation: "FORBIDDEN",
        overflow: "ERROR",
        nulls: "PRESERVE",
      },
    );
  const base = countPlan(
    ["left_value", "right_value"],
    [decimal(0), decimal(1)],
  );
  const plan: PhysicalQueryPlan = {
    ...base,
    metrics: [
      {
        outputIndex: 0,
        semanticType: { kind: "DECIMAL", precision: 38, scale: 4 },
        expression: {
          kind: "AGGREGATE",
          op: "SUM",
          aggregationPolicy: "EXACT_DECIMAL",
          overflow: "ERROR",
          requireFiniteResult: false,
          resultType: { kind: "DECIMAL", precision: 38, scale: 4 },
          expression: {
            kind: "BINARY",
            op: "MULTIPLY",
            arithmeticPolicy: "EXACT_DECIMAL",
            overflow: "ERROR",
            requireFiniteResult: false,
            resultType: { kind: "DECIMAL", precision: 36, scale: 4 },
            left: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 0,
              resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
            },
            right: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 1,
              resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
            },
          },
        },
      },
    ],
    output: [
      {
        outputIndex: 0,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: "product" },
        name: "product",
        label: "Product",
        semanticType: { kind: "DECIMAL", precision: 38, scale: 4 },
        physicalType: { kind: "DECIMAL", precision: 38, scale: 4 },
      },
    ],
  };
  const unscaled = BigInt("999999999999999999");
  const filename = await csv(
    "decimal-wide.csv",
    "left_value,right_value\n9999999999999999.99,9999999999999999.99\n",
  );
  const result = await execute(compile(plan), filename);
  expect(result).toMatchObject({ outcome: "SUCCESS", type: "DECIMAL(38,4)" });
  if (result.outcome !== "SUCCESS") return;
  expect(result.rows[0][0]).toMatchObject({
    width: 38,
    scale: 4,
    value: unscaled * unscaled,
  });
});

test.each([
  ["1e999999", "NUMERIC_OVERFLOW"],
  ["1e-999999", "NUMERIC_OVERFLOW"],
  ["NaN", "SOURCE_VALUE_INVALID"],
] as const)("classifies finite DOUBLE policy for %s", async (value, code) => {
  const field = sourceField(
    0,
    { kind: "NUMBER" },
    { kind: "DOUBLE" },
    {
      kind: "TEXT_TO_FINITE_DOUBLE",
      overflow: "ERROR",
      underflowToZero: "ERROR",
      nonFinite: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const filename = await csv(`number-${value.length}.csv`, `value\n${value}\n`);
  expect(
    await execute(compile(countPlan(["value"], [field])), filename),
  ).toEqual({
    outcome: "FAILED",
    code,
  });
});

test("classifies HUGEINT range and non-finite aggregate results", async () => {
  const integer = sourceField(
    0,
    { kind: "INTEGER" },
    { kind: "HUGEINT" },
    {
      kind: "TEXT_TO_EXACT_INTEGER",
      fractionalValues: "ERROR",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const integerFile = await csv(
    "integer-overflow.csv",
    "value\n170141183460469231731687303715884105728\n",
  );
  expect(
    await execute(compile(countPlan(["value"], [integer])), integerFile),
  ).toEqual({ outcome: "FAILED", code: "NUMERIC_OVERFLOW" });

  const number = sourceField(
    0,
    { kind: "NUMBER" },
    { kind: "DOUBLE" },
    {
      kind: "TEXT_TO_FINITE_DOUBLE",
      overflow: "ERROR",
      underflowToZero: "ERROR",
      nonFinite: "ERROR",
      nulls: "PRESERVE",
    },
  );
  const base = countPlan(["value"], [number], 2);
  const sumPlan: PhysicalQueryPlan = {
    ...base,
    metrics: [
      {
        outputIndex: 0,
        semanticType: { kind: "NUMBER" },
        expression: {
          kind: "AGGREGATE",
          op: "SUM",
          expression: {
            kind: "SOURCE_FIELD",
            sourceFieldIndex: 0,
            resultType: { kind: "DOUBLE" },
          },
          resultType: { kind: "DOUBLE" },
          aggregationPolicy: "APPROXIMATE_DOUBLE",
          overflow: "ERROR",
          requireFiniteResult: true,
        },
      },
    ],
    output: [
      {
        outputIndex: 0,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: "sum" },
        name: "sum",
        label: "Sum",
        semanticType: { kind: "NUMBER" },
        physicalType: { kind: "DOUBLE" },
      },
    ],
  };
  const numberFile = await csv(
    "number-result-overflow.csv",
    "value\n1e308\n1e308\n",
  );
  expect(await execute(compile(sumPlan), numberFile)).toEqual({
    outcome: "FAILED",
    code: "NUMERIC_OVERFLOW",
  });
});

test("validates BOOLEAN, temporals, NUL and UUID per used field", async () => {
  const fields = [
    sourceField(
      0,
      { kind: "BOOLEAN" },
      { kind: "BOOLEAN" },
      {
        kind: "TEXT_TO_BOOLEAN",
        acceptedTokens: ["true", "false"],
        nulls: "PRESERVE",
      },
    ),
    sourceField(
      1,
      { kind: "DATE" },
      { kind: "DATE" },
      { kind: "TEXT_TO_DATE", format: "YYYY-MM-DD", nulls: "PRESERVE" },
    ),
    sourceField(
      2,
      { kind: "DATETIME" },
      { kind: "TIMESTAMP" },
      {
        kind: "TEXT_TO_DATETIME",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]",
        timezone: "FORBIDDEN",
        nulls: "PRESERVE",
      },
    ),
    sourceField(
      3,
      { kind: "INSTANT" },
      { kind: "TIMESTAMPTZ" },
      {
        kind: "TEXT_TO_INSTANT",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z",
        timezone: "UTC_REQUIRED",
        nulls: "PRESERVE",
      },
    ),
    textField(4),
    sourceField(
      5,
      { kind: "STRING" },
      { kind: "TEXT" },
      { kind: "UUID_TEXT", invalid: "ERROR", nulls: "PRESERVE" },
    ),
  ];
  const columns = ["flag", "day", "local_time", "instant", "text", "uuid"];
  const valid = await csv(
    "types-valid.csv",
    "flag,day,local_time,instant,text,uuid\ntrue,2024-02-29,2024-01-02T03:04:05.123456,2024-01-02T03:04:05.123456Z,ação,550e8400-e29b-41d4-a716-446655440000\n",
  );
  expect(
    await execute(compile(countPlan(columns, fields)), valid),
  ).toMatchObject({
    outcome: "SUCCESS",
  });
  const invalid = await csv(
    "types-invalid.csv",
    "flag,day,local_time,instant,text,uuid\nTRUE,2023-02-29,2024-01-02T03:04:05Z,2024-01-02T03:04:05+01:00,a\\0b,invalid\n".replace(
      "\\0",
      "\0",
    ),
  );
  expect(await execute(compile(countPlan(columns, fields)), invalid)).toEqual({
    outcome: "FAILED",
    code: "SOURCE_VALUE_INVALID",
  });
});

test.each([
  [
    "boolean",
    sourceField(
      0,
      { kind: "BOOLEAN" },
      { kind: "BOOLEAN" },
      {
        kind: "TEXT_TO_BOOLEAN",
        acceptedTokens: ["true", "false"],
        nulls: "PRESERVE",
      },
    ),
    "TRUE",
  ],
  [
    "date",
    sourceField(
      0,
      { kind: "DATE" },
      { kind: "DATE" },
      { kind: "TEXT_TO_DATE", format: "YYYY-MM-DD", nulls: "PRESERVE" },
    ),
    "2023-02-29",
  ],
  ["string NUL", textField(), "a\0b"],
  [
    "UUID",
    sourceField(
      0,
      { kind: "STRING" },
      { kind: "TEXT" },
      { kind: "UUID_TEXT", invalid: "ERROR", nulls: "PRESERVE" },
    ),
    "invalid",
  ],
] as const)("rejects invalid %s independently", async (name, field, value) => {
  const filename = await csv(
    `invalid-${name.replace(" ", "-")}.csv`,
    `value\n${value}\n`,
  );
  expect(
    await execute(compile(countPlan(["value"], [field])), filename),
  ).toEqual({
    outcome: "FAILED",
    code: "SOURCE_VALUE_INVALID",
  });
});

test("strict row shape and row count fail as SOURCE_SCHEMA_MISMATCH", async () => {
  const shape = await csv("shape.csv", "value\n1,2\n");
  expect(
    await execute(compile(countPlan(["value"], [textField()])), shape),
  ).toEqual({ outcome: "FAILED", code: "SOURCE_SCHEMA_MISMATCH" });
  const count = await csv("count.csv", "value\n1\n2\n");
  expect(
    await execute(compile(countPlan(["value"], [textField()])), count),
  ).toEqual({ outcome: "FAILED", code: "SOURCE_SCHEMA_MISMATCH" });
});
