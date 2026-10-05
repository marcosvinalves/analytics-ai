import type { QueryExplanation } from "../../query/domain/query-explanation.ts";
import type {
  QueryResult,
  QueryResultColumn,
  QueryResultRow,
  QueryValue,
} from "../../query/domain/query-result.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";
import {
  validateVisualizationCompatibility,
  type VisualizationCompatibilityIssue,
  type VisualizationOutputReference,
  type VisualizationSpecV1,
} from "./visualization-spec.ts";

export type VisualizationOutput = Readonly<{
  role: "DIMENSION" | "METRIC";
  key: string;
  label: string;
  semanticType: SemanticType;
}>;

export type NumericVisualizationValue =
  | Readonly<{ type: "NULL" }>
  | Readonly<{
      type: "INTEGER" | "DECIMAL" | "NUMBER";
      value: string;
      exactness: "EXACT" | "APPROXIMATE";
      geometryValue?: number;
    }>;

export type CategoricalVisualizationValue =
  | Readonly<{ type: "NULL" }>
  | Readonly<{ type: "STRING"; value: string }>
  | Readonly<{ type: "BOOLEAN"; value: boolean }>;

export type TemporalVisualizationValue =
  | Readonly<{ type: "NULL" }>
  | Readonly<{
      type: "DATE" | "DATETIME" | "INSTANT";
      value: string;
    }>;

export type KpiViewModel =
  | Readonly<{
      type: "KPI";
      metric: VisualizationOutput;
      state: "EMPTY";
    }>
  | Readonly<{
      type: "KPI";
      metric: VisualizationOutput;
      state: "VALUE";
      value: NumericVisualizationValue;
    }>;

export type TableViewModel = Readonly<{
  type: "TABLE";
  columns: readonly VisualizationOutput[];
  rows: readonly QueryResultRow[];
}>;

export type BarViewModel = Readonly<{
  type: "BAR";
  category: VisualizationOutput;
  value: VisualizationOutput;
  points: readonly Readonly<{
    category: CategoricalVisualizationValue;
    value: NumericVisualizationValue;
  }>[];
}>;

export type LineViewModel = Readonly<{
  type: "LINE";
  x: VisualizationOutput;
  y: VisualizationOutput;
  points: readonly Readonly<{
    x: TemporalVisualizationValue;
    y: NumericVisualizationValue;
  }>[];
}>;

export type VisualizationViewModel =
  KpiViewModel | TableViewModel | BarViewModel | LineViewModel;

export type VisualizationInvalidResultReason =
  | "INVALID_RESULT_STRUCTURE"
  | "DUPLICATE_OUTPUT_IDENTITY"
  | "ROW_WIDTH_MISMATCH"
  | "CELL_TYPE_MISMATCH"
  | "KPI_CARDINALITY_INVALID";

export type VisualizationMappingResult =
  | Readonly<{ outcome: "MAPPED"; viewModel: VisualizationViewModel }>
  | Readonly<{
      outcome: "INCOMPATIBLE";
      issues: readonly VisualizationCompatibilityIssue[];
    }>
  | Readonly<{
      outcome: "INVALID_RESULT";
      reason: VisualizationInvalidResultReason;
    }>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validSemanticType(value: unknown): value is SemanticType {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const type = value as Partial<SemanticType>;
  if (type.kind === "DECIMAL")
    return (
      Number.isInteger(type.precision) &&
      Number.isInteger(type.scale) &&
      (type.precision ?? 0) >= 1 &&
      (type.precision ?? 0) <= 38 &&
      (type.scale ?? -1) >= 0 &&
      (type.scale ?? 0) <= (type.precision ?? -1)
    );
  return (
    type.kind === "STRING" ||
    type.kind === "BOOLEAN" ||
    type.kind === "INTEGER" ||
    type.kind === "NUMBER" ||
    type.kind === "DATE" ||
    type.kind === "DATETIME" ||
    type.kind === "INSTANT"
  );
}

function validColumn(value: unknown): value is QueryResultColumn {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const column = value as Partial<QueryResultColumn>;
  return (
    typeof column.key === "string" &&
    typeof column.label === "string" &&
    (column.role === "DIMENSION" || column.role === "METRIC") &&
    validSemanticType(column.semanticType)
  );
}

function validCell(
  cell: unknown,
  column: QueryResultColumn,
): cell is QueryValue {
  if (cell === null || typeof cell !== "object" || Array.isArray(cell))
    return false;
  const value = cell as Partial<QueryValue> & { value?: unknown };
  if (value.type === "NULL") return true;
  if (value.type !== column.semanticType.kind) return false;
  return value.type === "BOOLEAN"
    ? typeof value.value === "boolean"
    : typeof value.value === "string";
}

function invalid(
  reason: VisualizationInvalidResultReason,
): VisualizationMappingResult {
  return deepFreeze({ outcome: "INVALID_RESULT", reason });
}

function validateResult(
  result: QueryResult,
): VisualizationInvalidResultReason | undefined {
  if (
    result === null ||
    typeof result !== "object" ||
    !Array.isArray(result.columns) ||
    !Array.isArray(result.rows) ||
    !result.columns.every(validColumn) ||
    !result.rows.every(Array.isArray)
  )
    return "INVALID_RESULT_STRUCTURE";

  const identities = new Set<string>();
  for (const column of result.columns) {
    const identity = `${column.role}:${column.key}`;
    if (identities.has(identity)) return "DUPLICATE_OUTPUT_IDENTITY";
    identities.add(identity);
  }
  for (const row of result.rows) {
    if (row.length !== result.columns.length) return "ROW_WIDTH_MISMATCH";
    for (let index = 0; index < row.length; index += 1)
      if (!validCell(row[index], result.columns[index]))
        return "CELL_TYPE_MISMATCH";
  }
  return undefined;
}

function cloneSemanticType(type: SemanticType): SemanticType {
  return type.kind === "DECIMAL"
    ? { kind: "DECIMAL", precision: type.precision, scale: type.scale }
    : { kind: type.kind };
}

function cloneOutput(column: QueryResultColumn): VisualizationOutput {
  return {
    role: column.role,
    key: column.key,
    label: column.label,
    semanticType: cloneSemanticType(column.semanticType),
  };
}

function cloneValue(value: QueryValue): QueryValue {
  return { ...value };
}

function numericValue(value: QueryValue): NumericVisualizationValue {
  if (value.type === "NULL") return { type: "NULL" };
  if (
    value.type !== "INTEGER" &&
    value.type !== "DECIMAL" &&
    value.type !== "NUMBER"
  )
    throw new TypeError("Valor numerico inconsistente.");
  const geometryValue = Number(value.value);
  const mapped = {
    type: value.type,
    value: value.value,
    exactness: value.type === "NUMBER" ? "APPROXIMATE" : "EXACT",
  } as const;
  return Number.isFinite(geometryValue) ? { ...mapped, geometryValue } : mapped;
}

function categoricalValue(value: QueryValue): CategoricalVisualizationValue {
  if (value.type === "NULL") return { type: "NULL" };
  if (value.type === "STRING") return { type: "STRING", value: value.value };
  if (value.type === "BOOLEAN") return { type: "BOOLEAN", value: value.value };
  throw new TypeError("Valor categorico inconsistente.");
}

function temporalValue(value: QueryValue): TemporalVisualizationValue {
  if (value.type === "NULL") return { type: "NULL" };
  if (
    value.type === "DATE" ||
    value.type === "DATETIME" ||
    value.type === "INSTANT"
  )
    return { type: value.type, value: value.value };
  throw new TypeError("Valor temporal inconsistente.");
}

function outputIndex(
  columns: readonly QueryResultColumn[],
  reference: VisualizationOutputReference,
): number {
  return columns.findIndex(
    (column) => column.role === reference.role && column.key === reference.key,
  );
}

function mapTable(result: QueryResult): TableViewModel {
  return {
    type: "TABLE",
    columns: result.columns.map(cloneOutput),
    rows: result.rows.map((row) => row.map(cloneValue)),
  };
}

function mapKpi(
  spec: Extract<VisualizationSpecV1, { type: "KPI" }>,
  result: QueryResult,
): KpiViewModel | VisualizationMappingResult {
  if (result.rows.length > 1) return invalid("KPI_CARDINALITY_INVALID");
  const index = outputIndex(result.columns, spec.value);
  if (index < 0) return invalid("INVALID_RESULT_STRUCTURE");
  const metric = cloneOutput(result.columns[index]);
  return result.rows.length === 0
    ? { type: "KPI", metric, state: "EMPTY" }
    : {
        type: "KPI",
        metric,
        state: "VALUE",
        value: numericValue(result.rows[0][index]),
      };
}

function mapBar(
  spec: Extract<VisualizationSpecV1, { type: "BAR" }>,
  result: QueryResult,
): BarViewModel | VisualizationMappingResult {
  const categoryIndex = outputIndex(result.columns, spec.category);
  const valueIndex = outputIndex(result.columns, spec.value);
  if (categoryIndex < 0 || valueIndex < 0)
    return invalid("INVALID_RESULT_STRUCTURE");
  return {
    type: "BAR",
    category: cloneOutput(result.columns[categoryIndex]),
    value: cloneOutput(result.columns[valueIndex]),
    points: result.rows.map((row) => ({
      category: categoricalValue(row[categoryIndex]),
      value: numericValue(row[valueIndex]),
    })),
  };
}

function mapLine(
  spec: Extract<VisualizationSpecV1, { type: "LINE" }>,
  result: QueryResult,
): LineViewModel | VisualizationMappingResult {
  const xIndex = outputIndex(result.columns, spec.x);
  const yIndex = outputIndex(result.columns, spec.y);
  if (xIndex < 0 || yIndex < 0) return invalid("INVALID_RESULT_STRUCTURE");
  return {
    type: "LINE",
    x: cloneOutput(result.columns[xIndex]),
    y: cloneOutput(result.columns[yIndex]),
    points: result.rows.map((row) => ({
      x: temporalValue(row[xIndex]),
      y: numericValue(row[yIndex]),
    })),
  };
}

export function mapVisualization(
  spec: VisualizationSpecV1,
  result: QueryResult,
  orderBy: QueryExplanation["orderBy"],
): VisualizationMappingResult {
  const invalidReason = validateResult(result);
  if (invalidReason) return invalid(invalidReason);

  const compatibility = validateVisualizationCompatibility(spec, {
    phase: "POST_EXECUTION",
    columns: result.columns,
    orderBy,
  });
  if (!compatibility.compatible)
    return deepFreeze({
      outcome: "INCOMPATIBLE",
      issues: compatibility.issues.map((issue) => ({ ...issue })),
    });

  let viewModel: VisualizationViewModel | VisualizationMappingResult;
  if (spec.type === "TABLE") viewModel = mapTable(result);
  else if (spec.type === "KPI") viewModel = mapKpi(spec, result);
  else if (spec.type === "BAR") viewModel = mapBar(spec, result);
  else viewModel = mapLine(spec, result);

  if ("outcome" in viewModel) return viewModel;
  return deepFreeze({ outcome: "MAPPED", viewModel });
}
