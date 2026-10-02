import type { MetricExpression } from "../../semantic/domain/metric-expression.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";
import type { SemanticLiteral } from "./semantic-query.ts";

export const MAX_SEMANTIC_RESOLUTION_ISSUES = 32;

export type ResolvedField = Readonly<{
  fieldKey: string;
  name: string;
  label: string;
  semanticType: SemanticType;
  lineage: Readonly<{
    physicalName: string;
    physicalType: string;
    ordinalPosition: number;
  }>;
}>;

export type ResolvedMetric = Readonly<{
  metricKey: string;
  name: string;
  label: string;
  expression: MetricExpression;
  resultType: SemanticType;
  dependencies: readonly ResolvedField[];
}>;

export type ResolvedDimension = Readonly<{ field: ResolvedField }>;

export type ResolvedFilter =
  | Readonly<{
      field: ResolvedField;
      op: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE";
      value: SemanticLiteral;
    }>
  | Readonly<{
      field: ResolvedField;
      op: "IN";
      values: readonly SemanticLiteral[];
    }>
  | Readonly<{
      field: ResolvedField;
      op: "IS_NULL" | "IS_NOT_NULL";
    }>;

export type ResolvedOrder =
  | Readonly<{
      target: Readonly<{ kind: "METRIC"; metric: ResolvedMetric }>;
      direction: "ASC" | "DESC";
    }>
  | Readonly<{
      target: Readonly<{
        kind: "DIMENSION";
        dimension: ResolvedDimension;
      }>;
      direction: "ASC" | "DESC";
    }>;

export type ResolvedSemanticQuery = Readonly<{
  version: 1;
  model: Readonly<{ id: string; name: string }>;
  revision: Readonly<{
    id: string;
    revisionNumber: number;
    label: string;
    publishedAt: Date;
  }>;
  dataset: Readonly<{ id: string; name: string }>;
  datasetVersion: Readonly<{ id: string; versionNumber: number }>;
  metrics: readonly ResolvedMetric[];
  dimensions: readonly ResolvedDimension[];
  filters: readonly ResolvedFilter[];
  orderBy: readonly ResolvedOrder[];
  limit?: number;
}>;

export type SemanticResolutionIssueCode =
  | "UNKNOWN_METRIC"
  | "UNKNOWN_FIELD"
  | "INCOMPATIBLE_FILTER"
  | "DECIMAL_LITERAL_OUT_OF_RANGE"
  | "INVALID_ORDER"
  | "ISSUE_LIMIT_REACHED";

export type SemanticResolutionIssue = Readonly<{
  path: string;
  code: SemanticResolutionIssueCode;
  message: string;
}>;

export type ResolveSemanticQueryResult =
  | Readonly<{ outcome: "RESOLVED"; query: ResolvedSemanticQuery }>
  | Readonly<{
      outcome: "REVISION_NOT_PUBLISHED";
      status: "DRAFT" | "ARCHIVED";
    }>
  | Readonly<{
      outcome: "INVALID_SEMANTIC_QUERY";
      issues: readonly SemanticResolutionIssue[];
    }>;
