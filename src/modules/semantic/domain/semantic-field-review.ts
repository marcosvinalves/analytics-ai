import {
  classifyTypeCompatibility,
  type CompatibilityResult,
  type SemanticType,
} from "./semantic-field.ts";
import { parsePhysicalType } from "../../dataset/domain/physical-type.ts";

export type SemanticFieldReviewField = {
  id: string;
  fieldKey: string;
  name: string;
  label: string;
  description: string | null;
  semanticType: SemanticType;
  compatibility: CompatibilityResult;
  referencedByMetric: boolean;
};

export type SemanticFieldReviewColumn = {
  datasetColumnId: string;
  physicalName: string;
  physicalType: string;
  ordinalPosition: number;
  nullable: boolean | null;
  nullCount: string | null;
  proposedSemanticType: SemanticType | null;
  field: SemanticFieldReviewField | null;
};

export type SemanticFieldReview = {
  dataset: { id: string; name: string };
  revision: { id: string; revisionNumber: number; status: "DRAFT" };
  datasetVersion: { id: string; versionNumber: number; status: "READY" };
  columns: SemanticFieldReviewColumn[];
};

export type SemanticFieldReviewResult =
  | { outcome: "EDITABLE"; review: SemanticFieldReview }
  | { outcome: "NO_DRAFT" }
  | { outcome: "BROKEN"; message: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export function proposeSemanticType(physicalType: string): SemanticType | null {
  const physical = parsePhysicalType(physicalType);
  if (!physical) return null;
  switch (physical.family) {
    case "BOOLEAN":
      return { kind: "BOOLEAN" };
    case "INTEGER":
      return { kind: "INTEGER" };
    case "NUMBER":
      return { kind: "NUMBER" };
    case "DECIMAL":
      return {
        kind: "DECIMAL",
        precision: physical.precision,
        scale: physical.scale,
      };
    case "STRING":
      return { kind: "STRING" };
    case "DATE":
      return { kind: "DATE" };
    case "DATETIME":
      return { kind: "DATETIME" };
    case "INSTANT":
      return { kind: "INSTANT" };
    case "TIME":
    case "UUID":
      return null;
  }
}

export function technicalNameSuggestion(physicalName: string): string {
  return /^[a-z][a-z0-9_]{0,62}$/.test(physicalName) ? physicalName : "";
}

export function semanticTypeCompatibility(
  physicalType: string,
  semanticType: SemanticType | null,
): CompatibilityResult | null {
  return semanticType
    ? classifyTypeCompatibility(physicalType, semanticType)
    : null;
}

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
