"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { validId } from "@/modules/dataset/domain/dataset-detail";
import type {
  SemanticValidationIssue,
  SemanticValidationIssueCode,
} from "@/modules/semantic/domain/semantic-publication";
import { readSemanticMetricReview } from "@/modules/semantic/infrastructure/read-semantic-metric-review";
import {
  publishSemanticModelRevision,
  validateSemanticModelRevision,
} from "@/modules/semantic/infrastructure/semantic-publication";

export type PublicationIssueView = {
  area: "DATASET" | "FIELDS" | "METRICS" | "INTEGRITY";
  message: string;
  recoveryHref?: string;
};

export type ValidateSemanticDraftActionState =
  | { outcome: "IDLE" }
  | {
      outcome: "VALID";
      fieldCount: number;
      metricCount: number;
      message: string;
    }
  | {
      outcome: "INVALID";
      fieldCount: number;
      metricCount: number;
      issues: PublicationIssueView[];
      message: string;
    }
  | { outcome: "STALE" | "BROKEN" | "NOT_FOUND"; message: string }
  | { outcome: "OPERATIONAL_FAILURE"; message: string };

export type PublishSemanticDraftActionState =
  | { outcome: "IDLE" }
  | {
      outcome: "VALIDATION_FAILED";
      issues: PublicationIssueView[];
      message: string;
    }
  | { outcome: "STALE" | "BROKEN" | "NOT_FOUND"; message: string }
  | { outcome: "OPERATIONAL_FAILURE"; message: string }
  | { outcome: "PUBLICATION_OUTCOME_UNKNOWN"; message: string };

const notFound = {
  outcome: "NOT_FOUND",
  message: "A revisão semântica não foi encontrada.",
} as const;
const stale = {
  outcome: "STALE",
  message: "O estado da revisão mudou. Atualize a página para continuar.",
} as const;
const broken = {
  outcome: "BROKEN",
  message: "A configuração semântica não pôde ser lida com segurança.",
} as const;
const operational = {
  outcome: "OPERATIONAL_FAILURE",
  message: "A operação está temporariamente indisponível.",
} as const;

const issueViews: Record<SemanticValidationIssueCode, PublicationIssueView> = {
  NO_FIELDS: {
    area: "FIELDS",
    message: "Inclua ao menos um campo semântico.",
    recoveryHref: "#semantic-fields",
  },
  NO_METRICS: {
    area: "METRICS",
    message: "Crie ao menos uma métrica governada.",
    recoveryHref: "#semantic-metrics",
  },
  FIELD_PHYSICAL_COMPATIBILITY_INVALID: {
    area: "FIELDS",
    message: "Há um campo cuja interpretação semântica precisa ser revista.",
    recoveryHref: "#semantic-fields",
  },
  METRIC_TYPE_INVALID: {
    area: "METRICS",
    message: "Há uma métrica incompatível com os tipos selecionados.",
    recoveryHref: "#semantic-metrics",
  },
  DATASET_VERSION_NOT_READY: {
    area: "DATASET",
    message: "A versão de dados associada não está pronta para publicação.",
  },
  REVISION_DATASET_VERSION_MISMATCH: {
    area: "INTEGRITY",
    message:
      "A configuração semântica possui um vínculo de dados inconsistente.",
  },
  FIELD_LINEAGE_INVALID: {
    area: "INTEGRITY",
    message: "O lineage de um campo não pôde ser validado com segurança.",
  },
  FIELD_TYPE_INVALID: {
    area: "INTEGRITY",
    message: "O tipo persistido de um campo não pôde ser validado.",
  },
  METRIC_AST_INVALID: {
    area: "INTEGRITY",
    message: "A expressão persistida de uma métrica não pôde ser validada.",
  },
  METRIC_FIELD_REFERENCE_INVALID: {
    area: "INTEGRITY",
    message: "Uma métrica referencia um campo inválido.",
  },
  METRIC_REFERENCE_PROJECTION_MISMATCH: {
    area: "INTEGRITY",
    message: "As referências persistidas de uma métrica estão inconsistentes.",
  },
};

function publicationIssueViews(
  issues: readonly SemanticValidationIssue[],
): PublicationIssueView[] {
  return [...new Set(issues.map((issue) => issue.code))].map(
    (code) => issueViews[code],
  );
}

function exactValues(formData: FormData, keys: readonly string[]) {
  const actual = [...formData.keys()].filter(
    (key) => !key.startsWith("$ACTION_"),
  );
  return (
    actual.length === keys.length &&
    keys.every((key) => formData.getAll(key).length === 1)
  );
}

function scopeInput(formData: FormData) {
  const keys = ["datasetId", "semanticModelRevisionId"];
  if (!exactValues(formData, keys)) return null;
  const datasetId = formData.get("datasetId");
  const semanticModelRevisionId = formData.get("semanticModelRevisionId");
  return typeof datasetId === "string" &&
    typeof semanticModelRevisionId === "string" &&
    validId(datasetId) &&
    validId(semanticModelRevisionId)
    ? { datasetId, semanticModelRevisionId }
    : null;
}

function publicationInput(formData: FormData) {
  const keys = ["datasetId", "semanticModelRevisionId", "confirmPublication"];
  if (!exactValues(formData, keys)) return null;
  const datasetId = formData.get("datasetId");
  const semanticModelRevisionId = formData.get("semanticModelRevisionId");
  return typeof datasetId === "string" &&
    typeof semanticModelRevisionId === "string" &&
    formData.get("confirmPublication") === "true" &&
    validId(datasetId) &&
    validId(semanticModelRevisionId)
    ? { datasetId, semanticModelRevisionId }
    : null;
}

async function trustedContext() {
  const context = localUploadContext();
  if (!context) return null;
  const requestHeaders = await headers();
  return requestHeaders.get("origin") === context.origin &&
    requestHeaders.get("host") === new URL(context.origin).host
    ? context
    : null;
}

async function currentDraft(
  workspaceId: string,
  datasetId: string,
  semanticModelRevisionId: string,
) {
  const result = await readSemanticMetricReview(getMetadataPool(), {
    workspaceId,
    datasetId,
  });
  if (result.outcome !== "EDITABLE") return { result, matches: false };
  return {
    result,
    matches: result.review.revision.id === semanticModelRevisionId,
  };
}

function refresh(datasetId: string) {
  try {
    revalidatePath(`/data/datasets/${datasetId}`);
    revalidatePath(`/data/datasets/${datasetId}/semantic`);
  } catch {
    console.error("SEMANTIC_PUBLICATION_REVALIDATION_FAILED");
  }
}

export async function validateSemanticDraftAction(
  _previous: ValidateSemanticDraftActionState,
  formData: FormData,
): Promise<ValidateSemanticDraftActionState> {
  const values = scopeInput(formData);
  const context = await trustedContext();
  if (!values || !context) return notFound;
  try {
    const draft = await currentDraft(
      context.workspaceId,
      values.datasetId,
      values.semanticModelRevisionId,
    );
    if (draft.result.outcome === "NOT_FOUND") return notFound;
    if (draft.result.outcome === "OPERATIONAL_FAILURE") return operational;
    if (draft.result.outcome === "BROKEN") return broken;
    if (!draft.matches) return stale;

    const result = await validateSemanticModelRevision(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: values.semanticModelRevisionId,
    });
    if (result.outcome === "VALID")
      return {
        outcome: "VALID",
        fieldCount: result.fieldCount,
        metricCount: result.metricCount,
        message: "Válido nesta verificação",
      };
    if (result.outcome === "INVALID")
      return {
        outcome: "INVALID",
        fieldCount: result.fieldCount,
        metricCount: result.metricCount,
        issues: publicationIssueViews(result.issues),
        message: "A configuração ainda possui pendências.",
      };
    if (result.outcome === "NOT_FOUND") return notFound;
    if (result.outcome === "REVISION_NOT_DRAFT") {
      refresh(values.datasetId);
      return stale;
    }
    return operational;
  } catch {
    console.error("SEMANTIC_VALIDATION_FAILED");
    return operational;
  }
}

export async function publishSemanticDraftAction(
  _previous: PublishSemanticDraftActionState,
  formData: FormData,
): Promise<PublishSemanticDraftActionState> {
  const values = publicationInput(formData);
  const context = await trustedContext();
  if (!values || !context) return notFound;
  let navigate = false;
  try {
    const draft = await currentDraft(
      context.workspaceId,
      values.datasetId,
      values.semanticModelRevisionId,
    );
    if (draft.result.outcome === "NOT_FOUND") return notFound;
    if (draft.result.outcome === "OPERATIONAL_FAILURE") return operational;
    if (draft.result.outcome === "BROKEN") return broken;
    if (!draft.matches) return stale;

    const result = await publishSemanticModelRevision(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: values.semanticModelRevisionId,
    });
    if (
      result.outcome === "PUBLISHED" ||
      result.outcome === "ALREADY_PUBLISHED"
    )
      navigate = true;
    else if (result.outcome === "VALIDATION_FAILED")
      return {
        outcome: "VALIDATION_FAILED",
        issues: publicationIssueViews(result.issues),
        message:
          "A configuração atual mudou ou deixou de ser válida. Valide novamente antes de publicar.",
      };
    else if (result.outcome === "NOT_FOUND") return notFound;
    else if (result.outcome === "REVISION_NOT_DRAFT") return stale;
    else if (result.outcome === "PUBLICATION_OUTCOME_UNKNOWN") {
      refresh(values.datasetId);
      return {
        outcome: result.outcome,
        message:
          "Não foi possível confirmar a publicação. Atualize a página antes de qualquer nova tentativa.",
      };
    } else return operational;
  } catch {
    console.error("SEMANTIC_PUBLICATION_FAILED");
    return operational;
  }

  if (navigate) {
    refresh(values.datasetId);
    redirect(`/data/datasets/${values.datasetId}/semantic`);
  }
  return operational;
}
