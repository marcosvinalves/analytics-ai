import type { SemanticType } from "./semantic-field.ts";
import type { GovernedMetricClassification } from "./governed-metric-template.ts";

export type SemanticMetricReviewField = {
  datasetColumnId: string;
  fieldKey: string;
  name: string;
  label: string;
  semanticType: SemanticType;
  ordinalPosition: number;
};

export type SemanticMetricReviewMetric = {
  metricKey: string;
  name: string;
  label: string;
  description: string | null;
  resultType: SemanticType;
  dependencies: SemanticMetricReviewField[];
  classification: GovernedMetricClassification;
};

export type SemanticMetricReview = {
  dataset: { id: string; name: string };
  revision: { id: string; revisionNumber: number; status: "DRAFT" };
  datasetVersion: { id: string; versionNumber: number; status: "READY" };
  fields: SemanticMetricReviewField[];
  metrics: SemanticMetricReviewMetric[];
};

export type SemanticMetricReviewResult =
  | { outcome: "EDITABLE"; review: SemanticMetricReview }
  | { outcome: "NO_DRAFT" }
  | { outcome: "BROKEN"; message: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export function sameSemanticType(
  left: SemanticType,
  right: SemanticType,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "DECIMAL" ||
      (right.kind === "DECIMAL" &&
        left.precision === right.precision &&
        left.scale === right.scale))
  );
}
