import {
  classifyTypeCompatibility,
  validateSemanticType,
  type SemanticType,
} from "./semantic-field.ts";
import { validateMetricExpression } from "./metric-expression.ts";
import type {
  DatasetVersionStatus,
  SemanticModelRevisionSnapshot,
  SemanticRevisionStatus,
} from "./semantic-model.ts";

export type SemanticPublicationScope = {
  workspaceId: string;
  semanticModelRevisionId: string;
};

export type SemanticValidationIssueCode =
  | "REVISION_DATASET_VERSION_MISMATCH"
  | "DATASET_VERSION_NOT_READY"
  | "NO_FIELDS"
  | "NO_METRICS"
  | "FIELD_LINEAGE_INVALID"
  | "FIELD_TYPE_INVALID"
  | "FIELD_PHYSICAL_COMPATIBILITY_INVALID"
  | "METRIC_AST_INVALID"
  | "METRIC_FIELD_REFERENCE_INVALID"
  | "METRIC_REFERENCE_PROJECTION_MISMATCH"
  | "METRIC_TYPE_INVALID";

export type SemanticValidationIssue = {
  code: SemanticValidationIssueCode;
  path: string;
  message: string;
};

export type SemanticContentField = {
  fieldKey: string;
  physicalType: string | null;
  semanticType: SemanticType | null;
  lineageValid: boolean;
};

export type SemanticContentMetric = {
  metricKey: string;
  expression: unknown;
  projectedFieldKeys: string[];
};

export type SemanticRevisionContent = {
  sameDataset: boolean;
  datasetVersionStatus: DatasetVersionStatus;
  fields: SemanticContentField[];
  metrics: SemanticContentMetric[];
};

export type SemanticContentValidation = {
  issues: SemanticValidationIssue[];
  fieldCount: number;
  metricCount: number;
};

export type ValidateSemanticModelRevisionResult =
  | ({ outcome: "VALID" } & Omit<SemanticContentValidation, "issues">)
  | ({ outcome: "INVALID" } & SemanticContentValidation)
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "REVISION_NOT_DRAFT";
      status: Exclude<SemanticRevisionStatus, "DRAFT">;
    }
  | { outcome: "OPERATIONAL_FAILURE" };

export type PublishSemanticModelRevisionResult =
  | {
      outcome: "PUBLISHED";
      revision: SemanticModelRevisionSnapshot;
      archivedRevisionId: string | null;
    }
  | {
      outcome: "ALREADY_PUBLISHED";
      revision: SemanticModelRevisionSnapshot;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "REVISION_NOT_DRAFT"; status: "ARCHIVED" }
  | ({ outcome: "VALIDATION_FAILED" } & SemanticContentValidation)
  | { outcome: "OPERATIONAL_FAILURE" }
  | { outcome: "PUBLICATION_OUTCOME_UNKNOWN" };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function issue(
  code: SemanticValidationIssueCode,
  path: string,
  message: string,
): SemanticValidationIssue {
  return { code, path, message };
}

function metricIssueCode(code: string): SemanticValidationIssueCode {
  if (code === "UNKNOWN_FIELD") return "METRIC_FIELD_REFERENCE_INVALID";
  if (code === "INCOMPATIBLE_TYPE" || code === "DECIMAL_PRECISION_OVERFLOW")
    return "METRIC_TYPE_INVALID";
  return "METRIC_AST_INVALID";
}

/** Validates snapshot content without applying any lifecycle eligibility rule. */
export function validateSemanticRevisionContent(
  content: SemanticRevisionContent,
): SemanticContentValidation {
  const issues: SemanticValidationIssue[] = [];
  if (!content.sameDataset)
    issues.push(
      issue(
        "REVISION_DATASET_VERSION_MISMATCH",
        "revision.datasetVersionId",
        "A versão de dados não pertence ao Dataset do modelo semântico.",
      ),
    );
  if (content.datasetVersionStatus !== "READY")
    issues.push(
      issue(
        "DATASET_VERSION_NOT_READY",
        "revision.datasetVersionId",
        "A versão de dados precisa estar READY.",
      ),
    );
  if (!content.fields.length)
    issues.push(
      issue("NO_FIELDS", "fields", "A revisão precisa de ao menos um campo."),
    );
  if (!content.metrics.length)
    issues.push(
      issue(
        "NO_METRICS",
        "metrics",
        "A revisão precisa de ao menos uma métrica.",
      ),
    );

  const fields = new Map<string, SemanticType>();
  for (const field of [...content.fields].sort((a, b) =>
    a.fieldKey.localeCompare(b.fieldKey),
  )) {
    const path = `fields.${field.fieldKey}`;
    if (!field.lineageValid || field.physicalType === null) {
      issues.push(
        issue(
          "FIELD_LINEAGE_INVALID",
          path,
          "O campo não possui lineage físico válido.",
        ),
      );
      continue;
    }
    if (field.semanticType === null) {
      issues.push(
        issue(
          "FIELD_TYPE_INVALID",
          `${path}.semanticType`,
          "O tipo semântico do campo é inválido.",
        ),
      );
      continue;
    }
    try {
      validateSemanticType(field.semanticType);
      const compatibility = classifyTypeCompatibility(
        field.physicalType,
        field.semanticType,
      );
      if (compatibility.compatibility === "INVALID")
        issues.push(
          issue(
            "FIELD_PHYSICAL_COMPATIBILITY_INVALID",
            `${path}.semanticType`,
            "O tipo físico não admite a interpretação semântica declarada.",
          ),
        );
      else fields.set(field.fieldKey, field.semanticType);
    } catch {
      issues.push(
        issue(
          "FIELD_TYPE_INVALID",
          `${path}.semanticType`,
          "O tipo semântico do campo é inválido.",
        ),
      );
    }
  }

  for (const metric of [...content.metrics].sort((a, b) =>
    a.metricKey.localeCompare(b.metricKey),
  )) {
    const path = `metrics.${metric.metricKey}`;
    const validated = validateMetricExpression(metric.expression, fields);
    if (!validated.valid) {
      issues.push(
        issue(
          metricIssueCode(validated.error.code),
          `${path}.expression${validated.error.path.slice(1)}`,
          "A expressão da métrica é inválida.",
        ),
      );
      continue;
    }
    const projected = [...new Set(metric.projectedFieldKeys)].sort();
    if (
      projected.length !== metric.projectedFieldKeys.length ||
      projected.join(",") !== validated.value.fieldKeys.join(",")
    )
      issues.push(
        issue(
          "METRIC_REFERENCE_PROJECTION_MISMATCH",
          `${path}.fieldReferences`,
          "As referências persistidas não correspondem à expressão da métrica.",
        ),
      );
  }

  return {
    issues: issues.sort(
      (a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code),
    ),
    fieldCount: content.fields.length,
    metricCount: content.metrics.length,
  };
}

export function validateSemanticPublicationScope(
  input: SemanticPublicationScope,
): void {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !==
      "semanticModelRevisionId,workspaceId" ||
    typeof input.workspaceId !== "string" ||
    !UUID.test(input.workspaceId) ||
    typeof input.semanticModelRevisionId !== "string" ||
    !UUID.test(input.semanticModelRevisionId)
  )
    throw new TypeError("Argumentos inválidos para publicação semântica.");
}
