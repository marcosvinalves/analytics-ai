import type {
  AnalyticalMaterialHandle,
  AnalyticalMaterialIdentity,
} from "../../dataset/domain/analytical-source.ts";
import type { PhysicalType } from "../../dataset/domain/physical-type.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";

export type PhysicalValueType =
  | Readonly<{ kind: "TEXT" }>
  | Readonly<{ kind: "BOOLEAN" }>
  | Readonly<{ kind: "HUGEINT" }>
  | Readonly<{ kind: "BIGINT" }>
  | Readonly<{ kind: "DOUBLE" }>
  | Readonly<{ kind: "DATE" }>
  | Readonly<{ kind: "TIMESTAMP" }>
  | Readonly<{ kind: "TIMESTAMPTZ" }>
  | Readonly<{ kind: "DECIMAL"; precision: number; scale: number }>;

export type FiniteDoublePolicy = Readonly<{
  kind: "TEXT_TO_FINITE_DOUBLE";
  overflow: "ERROR";
  underflowToZero: "ERROR";
  nonFinite: "ERROR";
}>;

type CommonSourceConversion = Readonly<{ nulls: "PRESERVE" }>;

export type SourceConversionPolicy =
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_IDENTITY";
        trim: false;
        normalizeUnicode: false;
        rejectNul: true;
      }>)
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_TO_BOOLEAN";
        acceptedTokens: readonly ["true", "false"];
      }>)
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_TO_EXACT_INTEGER";
        fractionalValues: "ERROR";
        overflow: "ERROR";
      }>)
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_TO_EXACT_DECIMAL";
        precision: number;
        scale: number;
        scientificNotation: "ERROR";
        rounding: "FORBIDDEN";
        truncation: "FORBIDDEN";
        overflow: "ERROR";
      }>)
  | (CommonSourceConversion & FiniteDoublePolicy)
  | (CommonSourceConversion &
      Readonly<{ kind: "TEXT_TO_DATE"; format: "YYYY-MM-DD" }>)
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_TO_DATETIME";
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]";
        timezone: "FORBIDDEN";
      }>)
  | (CommonSourceConversion &
      Readonly<{
        kind: "TEXT_TO_INSTANT";
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z";
        timezone: "UTC_REQUIRED";
      }>)
  | (CommonSourceConversion &
      Readonly<{ kind: "UUID_TEXT"; invalid: "ERROR" }>);

export type PlannedSourceField = Readonly<{
  fieldKey: string;
  columnIndex: number;
  semanticType: SemanticType;
  persistedPhysicalType: PhysicalType;
  compatibility: "EXECUTABLE_SAFE" | "EXECUTABLE_EXPLICIT";
  conversion: SourceConversionPolicy;
  resultType: PhysicalValueType;
}>;

export type PhysicalLiteral = Readonly<{
  kind: "LITERAL";
  literalType: SemanticType;
  value: string | boolean;
  resultType: PhysicalValueType;
  capability?: FiniteDoublePolicy;
}>;

export type PhysicalExpression =
  | Readonly<{
      kind: "SOURCE_FIELD";
      sourceFieldIndex: number;
      resultType: PhysicalValueType;
    }>
  | PhysicalLiteral
  | Readonly<{
      kind: "BINARY";
      op: "ADD" | "SUBTRACT" | "MULTIPLY";
      left: PhysicalExpression;
      right: PhysicalExpression;
      resultType: PhysicalValueType;
      arithmeticPolicy:
        "EXACT_INTEGER" | "EXACT_DECIMAL" | "APPROXIMATE_DOUBLE";
      overflow: "ERROR";
      requireFiniteResult: boolean;
    }>
  | Readonly<{
      kind: "AGGREGATE";
      op: "SUM" | "COUNT" | "COUNT_DISTINCT";
      expression: PhysicalExpression;
      resultType: PhysicalValueType;
      aggregationPolicy:
        | "EXACT_INTEGER"
        | "EXACT_DECIMAL"
        | "APPROXIMATE_DOUBLE"
        | "CARDINALITY";
      overflow: "ERROR";
      requireFiniteResult: boolean;
    }>;

export type PhysicalFilter =
  | Readonly<{
      field: Extract<PhysicalExpression, { kind: "SOURCE_FIELD" }>;
      op: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE";
      value: PhysicalLiteral;
    }>
  | Readonly<{
      field: Extract<PhysicalExpression, { kind: "SOURCE_FIELD" }>;
      op: "IN";
      values: readonly PhysicalLiteral[];
    }>
  | Readonly<{
      field: Extract<PhysicalExpression, { kind: "SOURCE_FIELD" }>;
      op: "IS_NULL" | "IS_NOT_NULL";
    }>;

export type OutputDescriptor = Readonly<{
  outputIndex: number;
  role: "DIMENSION" | "METRIC";
  semanticKey:
    | Readonly<{ kind: "FIELD"; fieldKey: string }>
    | Readonly<{ kind: "METRIC"; metricKey: string }>;
  name: string;
  label: string;
  semanticType: SemanticType;
  physicalType: PhysicalValueType;
}>;

export type PhysicalCsvSource = Readonly<{
  kind: "CSV";
  material: AnalyticalMaterialHandle;
  materialIdentity: AnalyticalMaterialIdentity;
  expectedSizeBytes: bigint;
  expectedRowCount: bigint;
  columns: readonly Readonly<{
    physicalName: string;
    ordinalPosition: number;
  }>[];
  readMode: "TEXT";
  dialect: Readonly<{
    encoding: "UTF-8";
    delimiter: ",";
    quote: '"';
    escape: '"';
    header: true;
    strict: true;
    emptyField: "NULL";
    quotedEmptyField: "NULL";
  }>;
  schemaValidation: Readonly<{
    headerRequired: true;
    exactColumnCount: true;
    exactNamesAndOrder: true;
    duplicateNames: "ERROR";
    invalidRowShape: "ERROR";
    expectedRowCount: bigint;
  }>;
}>;

export type PlannedDimension = Readonly<{
  outputIndex: number;
  expression: Extract<PhysicalExpression, { kind: "SOURCE_FIELD" }>;
  semanticType: SemanticType;
}>;

export type PlannedMetric = Readonly<{
  outputIndex: number;
  expression: Extract<PhysicalExpression, { kind: "AGGREGATE" }>;
  semanticType: SemanticType;
}>;

export type PlannedOrder = Readonly<{
  outputIndex: number;
  direction: "ASC" | "DESC";
  nulls: "LAST";
}>;

export type PhysicalQueryPlan = Readonly<{
  version: 1;
  context: Readonly<{
    semanticModelId: string;
    semanticModelRevisionId: string;
    datasetId: string;
    datasetVersionId: string;
  }>;
  source: PhysicalCsvSource;
  sourceFields: readonly PlannedSourceField[];
  dimensions: readonly PlannedDimension[];
  metrics: readonly PlannedMetric[];
  filters: readonly PhysicalFilter[];
  orderBy: readonly PlannedOrder[];
  semanticLimit?: number;
  output: readonly OutputDescriptor[];
}>;

export type PlanPhysicalQueryResult =
  | Readonly<{ outcome: "PLANNED"; plan: PhysicalQueryPlan }>
  | Readonly<{ outcome: "SOURCE_MISMATCH" }>
  | Readonly<{ outcome: "UNSUPPORTED_SOURCE_TYPE" }>
  | Readonly<{
      outcome: "UNSUPPORTED_PHYSICAL_CONVERSION";
      fieldKey: string;
    }>
  | Readonly<{
      outcome: "INCONSISTENT_RESOLVED_QUERY";
      path: string;
    }>;
