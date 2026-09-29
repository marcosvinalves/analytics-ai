import { validateSemanticType, type SemanticType } from "./semantic-field.ts";
import {
  validateMetricExpression,
  type MetricExpression,
} from "./metric-expression.ts";
import type {
  DatasetVersionStatus,
  SemanticRevisionStatus,
} from "./semantic-model.ts";
import {
  validateSemanticRevisionContent,
  type SemanticValidationIssue,
} from "./semantic-publication.ts";

export type InspectPublishedSemanticModelInput = {
  workspaceId: string;
  semanticModelId: string;
};

export type InspectSemanticModelRevisionInput = {
  workspaceId: string;
  semanticModelRevisionId: string;
};

export type SemanticFieldInspection = {
  fieldKey: string;
  name: string;
  label: string;
  description: string | null;
  semanticType: SemanticType;
  lineage: {
    physicalName: string;
    physicalType: string;
    ordinalPosition: number;
  };
};

export type MetricInspection = {
  metricKey: string;
  name: string;
  label: string;
  description: string | null;
  expression: MetricExpression;
  resultType: SemanticType;
  dependencies: string[];
};

export type SemanticModelInspection = {
  model: { id: string; name: string };
  revision: {
    id: string;
    revisionNumber: number;
    status: SemanticRevisionStatus;
    label: string;
    description: string | null;
    createdAt: Date;
    publishedAt: Date | null;
  };
  dataset: { id: string; name: string };
  datasetVersion: {
    id: string;
    versionNumber: number;
    status: DatasetVersionStatus;
  };
  fields: SemanticFieldInspection[];
  metrics: MetricInspection[];
};

export type SemanticInspectionFieldCandidate = Omit<
  SemanticFieldInspection,
  "semanticType" | "lineage"
> & {
  semanticType: SemanticType | null;
  physicalName: string | null;
  physicalType: string | null;
  ordinalPosition: number | null;
  lineageValid: boolean;
};

export type SemanticInspectionMetricCandidate = Omit<
  MetricInspection,
  "expression" | "resultType" | "dependencies"
> & {
  expression: unknown;
  projectedFieldKeys: string[];
};

export type SemanticInspectionCandidate = Omit<
  SemanticModelInspection,
  "fields" | "metrics"
> & {
  sameDataset: boolean;
  fields: SemanticInspectionFieldCandidate[];
  metrics: SemanticInspectionMetricCandidate[];
};

export type SemanticInspectionAssembly =
  | { consistent: true; inspection: SemanticModelInspection }
  | { consistent: false; issues: SemanticValidationIssue[] };

type InconsistentInspection = {
  outcome: "INCONSISTENT_SNAPSHOT";
  semanticModelRevisionId: string;
  status: SemanticRevisionStatus;
  issues: SemanticValidationIssue[];
};

type InspectionSuccess = {
  outcome: "SUCCESS";
  inspection: SemanticModelInspection;
};

export type InspectSemanticModelRevisionResult =
  | InspectionSuccess
  | InconsistentInspection
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type InspectPublishedSemanticModelResult =
  | InspectionSuccess
  | InconsistentInspection
  | { outcome: "NOT_FOUND" }
  | { outcome: "NO_PUBLISHED_REVISION" }
  | { outcome: "OPERATIONAL_FAILURE" };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateInput(
  input: Record<string, unknown>,
  identifier: "semanticModelId" | "semanticModelRevisionId",
): void {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !==
      [identifier, "workspaceId"].sort().join(",") ||
    typeof input.workspaceId !== "string" ||
    !UUID.test(input.workspaceId) ||
    typeof input[identifier] !== "string" ||
    !UUID.test(input[identifier])
  )
    throw new TypeError("Argumentos inválidos para inspeção semântica.");
}

export function validateInspectPublishedSemanticModelInput(
  input: InspectPublishedSemanticModelInput,
): void {
  validateInput(input, "semanticModelId");
}

export function validateInspectSemanticModelRevisionInput(
  input: InspectSemanticModelRevisionInput,
): void {
  validateInput(input, "semanticModelRevisionId");
}

export function assembleSemanticModelInspection(
  candidate: SemanticInspectionCandidate,
): SemanticInspectionAssembly {
  const validation = validateSemanticRevisionContent({
    sameDataset: candidate.sameDataset,
    datasetVersionStatus: candidate.datasetVersion.status,
    fields: candidate.fields.map((field) => ({
      fieldKey: field.fieldKey,
      physicalType: field.physicalType,
      semanticType: field.semanticType,
      lineageValid:
        field.lineageValid &&
        field.physicalName !== null &&
        field.physicalType !== null &&
        field.ordinalPosition !== null,
    })),
    metrics: candidate.metrics.map((metric) => ({
      metricKey: metric.metricKey,
      expression: metric.expression,
      projectedFieldKeys: metric.projectedFieldKeys,
    })),
  });
  if (validation.issues.length)
    return { consistent: false, issues: validation.issues };

  const fields = candidate.fields.map((field): SemanticFieldInspection => {
    if (
      field.semanticType === null ||
      field.physicalName === null ||
      field.physicalType === null ||
      field.ordinalPosition === null
    )
      throw new Error("SEMANTIC_INSPECTION_INCONSISTENT");
    validateSemanticType(field.semanticType);
    return {
      fieldKey: field.fieldKey,
      name: field.name,
      label: field.label,
      description: field.description,
      semanticType: field.semanticType,
      lineage: {
        physicalName: field.physicalName,
        physicalType: field.physicalType,
        ordinalPosition: field.ordinalPosition,
      },
    };
  });
  fields.sort(
    (left, right) =>
      left.lineage.ordinalPosition - right.lineage.ordinalPosition ||
      compareText(left.fieldKey, right.fieldKey),
  );
  const fieldTypes = new Map(
    fields.map((field) => [field.fieldKey, field.semanticType]),
  );
  const metrics = candidate.metrics.map((metric): MetricInspection => {
    const validated = validateMetricExpression(metric.expression, fieldTypes);
    if (!validated.valid) throw new Error("SEMANTIC_INSPECTION_INCONSISTENT");
    return {
      metricKey: metric.metricKey,
      name: metric.name,
      label: metric.label,
      description: metric.description,
      expression: validated.value.expression,
      resultType: validated.value.resultType,
      dependencies: validated.value.fieldKeys,
    };
  });
  metrics.sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.metricKey, right.metricKey),
  );
  return {
    consistent: true,
    inspection: {
      model: candidate.model,
      revision: candidate.revision,
      dataset: candidate.dataset,
      datasetVersion: candidate.datasetVersion,
      fields,
      metrics,
    },
  };
}
