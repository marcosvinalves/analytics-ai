import type { SemanticType } from "../../semantic/domain/semantic-field.ts";

export const MAX_QUERY_EXPLANATION_ISSUES = 16;

export type NumericSemantics = "EXACT" | "APPROXIMATE";

export type QueryExplanationField = Readonly<{
  fieldKey: string;
  name: string;
  label: string;
  semanticType: SemanticType;
}>;

export type QueryExplanationLiteral =
  | Readonly<{ semanticType: "STRING"; value: string }>
  | Readonly<{ semanticType: "BOOLEAN"; value: boolean }>
  | Readonly<{ semanticType: "INTEGER"; value: string }>
  | Readonly<{ semanticType: "DECIMAL"; value: string }>
  | Readonly<{ semanticType: "NUMBER"; value: string }>
  | Readonly<{ semanticType: "DATE"; value: string }>
  | Readonly<{ semanticType: "DATETIME"; value: string }>
  | Readonly<{ semanticType: "INSTANT"; value: string }>;

export type QueryExplanationScalarExpression =
  | Readonly<{ kind: "FIELD"; fieldKey: string; label: string }>
  | Readonly<{
      kind: "LITERAL";
      semanticType: "INTEGER" | "DECIMAL";
      value: string;
    }>
  | Readonly<{
      kind: "BINARY";
      operator: "ADD" | "SUBTRACT" | "MULTIPLY";
      left: QueryExplanationScalarExpression;
      right: QueryExplanationScalarExpression;
    }>;

export type QueryExplanationMetricExpression = Readonly<{
  kind: "AGGREGATE";
  operator: "SUM" | "COUNT" | "COUNT_DISTINCT";
  expression: QueryExplanationScalarExpression;
}>;

export type QueryExplanationMetric = Readonly<{
  metricKey: string;
  name: string;
  label: string;
  resultType: SemanticType;
  numericSemantics: NumericSemantics;
  expression: QueryExplanationMetricExpression;
  dependencies: readonly QueryExplanationField[];
}>;

export type QueryExplanationFilter =
  | Readonly<{
      field: QueryExplanationField;
      operator: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE";
      value: QueryExplanationLiteral;
    }>
  | Readonly<{
      field: QueryExplanationField;
      operator: "IN";
      values: readonly QueryExplanationLiteral[];
    }>
  | Readonly<{
      field: QueryExplanationField;
      operator: "IS_NULL" | "IS_NOT_NULL";
    }>;

export type QueryExplanationOrder = Readonly<{
  target: Readonly<{
    role: "DIMENSION" | "METRIC";
    key: string;
    label: string;
  }>;
  direction: "ASC" | "DESC";
  nulls: "LAST";
}>;

export type QueryExplanationOutput = Readonly<{
  key: string;
  label: string;
  role: "DIMENSION" | "METRIC";
  semanticType: SemanticType;
  numericSemantics?: NumericSemantics;
}>;

export type QueryExplanation = Readonly<{
  version: 1;
  model: Readonly<{ id: string; name: string }>;
  revision: Readonly<{
    id: string;
    revisionNumber: number;
    label: string;
    publishedAt: string;
  }>;
  dataset: Readonly<{ id: string; name: string }>;
  datasetVersion: Readonly<{ id: string; versionNumber: number }>;
  metrics: readonly QueryExplanationMetric[];
  dimensions: readonly QueryExplanationField[];
  filters: Readonly<{
    combination: "AND";
    items: readonly QueryExplanationFilter[];
  }>;
  orderBy: readonly QueryExplanationOrder[];
  semanticLimit?: number;
  outputs: readonly QueryExplanationOutput[];
  resultShape: Readonly<{ rowCount: number; columnCount: number }>;
}>;

export type QueryExplanationIssueCode =
  "SEMANTIC_MISMATCH" | "RESULT_MISMATCH" | "ISSUE_LIMIT_REACHED";

export type QueryExplanationIssue = Readonly<{
  path: string;
  code: QueryExplanationIssueCode;
  message: string;
}>;

export type BuildQueryExplanationResult =
  | Readonly<{ outcome: "EXPLAINED"; explanation: QueryExplanation }>
  | Readonly<{
      outcome: "INCONSISTENT_QUERY_ARTIFACTS";
      issues: readonly QueryExplanationIssue[];
    }>;
