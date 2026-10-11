"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { validId } from "@/modules/dataset/domain/dataset-detail";
import {
  buildGovernedMetricExpression,
  classifyGovernedMetricExpression,
  isGovernedMetricTemplate,
  type GovernedMetricTemplate,
} from "@/modules/semantic/domain/governed-metric-template";
import {
  sameSemanticType,
  type SemanticMetricReview,
  type SemanticMetricReviewMetric,
} from "@/modules/semantic/domain/semantic-metric-review";
import { readSemanticMetricReview } from "@/modules/semantic/infrastructure/read-semantic-metric-review";
import {
  createMetric,
  removeMetric,
  updateMetric,
} from "@/modules/semantic/infrastructure/metrics";

export type SemanticMetricActionState =
  | { outcome: "IDLE" }
  | {
      outcome: "SAVED";
      operation: "CREATED" | "UPDATED" | "UNCHANGED";
      message: string;
    }
  | { outcome: "REMOVED"; message: string }
  | {
      outcome:
        | "INVALID_INPUT"
        | "INCOMPATIBLE_FIELDS"
        | "CONFLICT"
        | "REVISION_NOT_EDITABLE"
        | "NOT_FOUND";
      message: string;
    }
  | {
      outcome: "OPERATIONAL_FAILURE";
      code: "WRITE_FAILED" | "OUTCOME_UNKNOWN";
      message: string;
    };

type MetricValues = {
  datasetId: string;
  metricKey?: string;
  template: GovernedMetricTemplate;
  firstDatasetColumnId: string;
  secondDatasetColumnId: string | null;
  name: string;
  label: string;
  description: string | null;
};

const createKeys = [
  "datasetId",
  "template",
  "firstDatasetColumnId",
  "secondDatasetColumnId",
  "name",
  "label",
  "description",
] as const;
const updateKeys = ["metricKey", ...createKeys] as const;
const notFound = {
  outcome: "NOT_FOUND",
  message: "Métrica ou draft não encontrado.",
} as const;

function exactValues(formData: FormData, keys: readonly string[]) {
  const actual = [...formData.keys()].filter(
    (key) => !key.startsWith("$ACTION_"),
  );
  return (
    actual.length === keys.length &&
    keys.every((key) => formData.getAll(key).length === 1)
  );
}

function editInput(
  formData: FormData,
  operation: "create" | "update",
): MetricValues | null {
  const keys = operation === "create" ? createKeys : updateKeys;
  if (!exactValues(formData, keys)) return null;
  const values = Object.fromEntries(
    keys.map((key) => [key, formData.get(key)]),
  ) as Record<string, FormDataEntryValue | null>;
  if (Object.values(values).some((value) => typeof value !== "string"))
    return null;
  const strings = values as Record<string, string>;
  if (
    !validId(strings.datasetId) ||
    !validId(strings.firstDatasetColumnId) ||
    (operation === "update" && !validId(strings.metricKey)) ||
    !isGovernedMetricTemplate(strings.template) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(strings.name) ||
    strings.label !== strings.label.trim() ||
    strings.label.length < 1 ||
    strings.label.length > 200 ||
    strings.description !== strings.description.trim() ||
    strings.description.length > 2000
  )
    return null;
  const multiply = strings.template === "SUM_MULTIPLY_FIELDS";
  if (
    (multiply && !validId(strings.secondDatasetColumnId)) ||
    (!multiply && strings.secondDatasetColumnId !== "")
  )
    return null;
  return {
    datasetId: strings.datasetId,
    metricKey: operation === "update" ? strings.metricKey : undefined,
    template: strings.template,
    firstDatasetColumnId: strings.firstDatasetColumnId,
    secondDatasetColumnId: multiply ? strings.secondDatasetColumnId : null,
    name: strings.name,
    label: strings.label,
    description: strings.description || null,
  };
}

async function trustedRequest() {
  const context = localUploadContext();
  if (!context) return null;
  const requestHeaders = await headers();
  return requestHeaders.get("origin") === context.origin &&
    requestHeaders.get("host") === new URL(context.origin).host
    ? context
    : null;
}

function refresh(datasetId: string) {
  try {
    revalidatePath(`/data/datasets/${datasetId}/semantic`);
  } catch {
    console.error("SEMANTIC_METRIC_REVIEW_REVALIDATION_FAILED");
  }
}

async function editableReview(datasetId: string, workspaceId: string) {
  return readSemanticMetricReview(getMetadataPool(), {
    workspaceId,
    datasetId,
  });
}

function desired(review: SemanticMetricReview, values: MetricValues) {
  const first = review.fields.find(
    (field) => field.datasetColumnId === values.firstDatasetColumnId,
  );
  const second = values.secondDatasetColumnId
    ? review.fields.find(
        (field) => field.datasetColumnId === values.secondDatasetColumnId,
      )
    : undefined;
  if (!first || (values.secondDatasetColumnId && !second)) return null;
  const fields = new Map(
    review.fields.map((field) => [field.fieldKey, field.semanticType]),
  );
  const built = buildGovernedMetricExpression(
    {
      template: values.template,
      firstFieldKey: first.fieldKey,
      secondFieldKey: second?.fieldKey,
    },
    fields,
  );
  return built.valid ? built.value : null;
}

function sameMetric(
  metric: SemanticMetricReviewMetric,
  values: MetricValues,
  expression: NonNullable<ReturnType<typeof desired>>,
) {
  const classified = metric.classification;
  const desiredClassification = classifyGovernedMetricExpression(
    expression.expression,
  );
  return (
    metric.name === values.name &&
    metric.label === values.label &&
    metric.description === values.description &&
    classified.kind === "SUPPORTED" &&
    desiredClassification.kind === "SUPPORTED" &&
    classified.template === desiredClassification.template &&
    classified.firstFieldKey === desiredClassification.firstFieldKey &&
    classified.secondFieldKey === desiredClassification.secondFieldKey &&
    sameSemanticType(metric.resultType, expression.resultType) &&
    metric.dependencies.length === expression.fieldKeys.length &&
    metric.dependencies.every((field) =>
      expression.fieldKeys.includes(field.fieldKey),
    )
  );
}

async function metricId(
  workspaceId: string,
  revisionId: string,
  metricKey: string,
) {
  return (
    await getMetadataPool().query<{ id: string }>(
      `SELECT x.id FROM app.metrics x
       JOIN app.semantic_model_revisions r ON r.id=x.semantic_model_revision_id
       JOIN app.semantic_models m ON m.id=r.semantic_model_id
       JOIN app.datasets d ON d.id=m.dataset_id
       WHERE x.metric_key=$1 AND x.semantic_model_revision_id=$2
         AND d.workspace_id=$3`,
      [metricKey, revisionId, workspaceId],
    )
  ).rows[0]?.id;
}

function failure(
  result:
    | Awaited<ReturnType<typeof createMetric>>
    | Awaited<ReturnType<typeof updateMetric>>,
): SemanticMetricActionState {
  if (result.outcome === "REVISION_NOT_EDITABLE")
    return {
      outcome: "REVISION_NOT_EDITABLE",
      message: "O draft não é mais editável. Atualize a página.",
    };
  if (result.outcome === "INVALID_EXPRESSION")
    return {
      outcome: "INCOMPATIBLE_FIELDS",
      message: "Os campos selecionados não são compatíveis com este template.",
    };
  if (result.outcome === "CONFLICT")
    return {
      outcome: "CONFLICT",
      message:
        "Outra métrica usa esse nome. Revise os dados e tente novamente.",
    };
  return notFound;
}

function operational(
  error: unknown,
  datasetId?: string,
): SemanticMetricActionState {
  if (datasetId) refresh(datasetId);
  const unknown =
    error instanceof Error && error.message === "METRIC_OUTCOME_UNKNOWN";
  return {
    outcome: "OPERATIONAL_FAILURE",
    code: unknown ? "OUTCOME_UNKNOWN" : "WRITE_FAILED",
    message: unknown
      ? "Não foi possível confirmar o resultado. Atualize a página antes de tentar novamente."
      : "Não foi possível salvar a métrica. Revise os dados antes de tentar novamente.",
  };
}

export async function createSemanticMetricAction(
  _previous: SemanticMetricActionState,
  formData: FormData,
): Promise<SemanticMetricActionState> {
  const values = editInput(formData, "create");
  const context = await trustedRequest();
  if (!values || !context)
    return { outcome: "INVALID_INPUT", message: "Dados inválidos." };
  try {
    const current = await editableReview(values.datasetId, context.workspaceId);
    if (current.outcome !== "EDITABLE") return notFound;
    const expression = desired(current.review, values);
    if (!expression)
      return {
        outcome: "INCOMPATIBLE_FIELDS",
        message:
          "Os campos selecionados não são compatíveis com este template.",
      };
    const result = await createMetric(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: current.review.revision.id,
      name: values.name,
      label: values.label,
      description: values.description,
      expression: expression.expression,
    });
    if (result.outcome !== "CREATED") {
      if (result.outcome === "CONFLICT") {
        const latest = await editableReview(
          values.datasetId,
          context.workspaceId,
        );
        const existing =
          latest.outcome === "EDITABLE"
            ? latest.review.metrics.find(
                (metric) => metric.name === values.name,
              )
            : undefined;
        const latestExpression =
          latest.outcome === "EDITABLE" ? desired(latest.review, values) : null;
        if (
          existing &&
          latestExpression &&
          sameMetric(existing, values, latestExpression)
        ) {
          refresh(values.datasetId);
          return {
            outcome: "SAVED",
            operation: "UNCHANGED",
            message: "Esta métrica já estava salva.",
          };
        }
      }
      return failure(result);
    }
    await editableReview(values.datasetId, context.workspaceId);
    refresh(values.datasetId);
    return {
      outcome: "SAVED",
      operation: "CREATED",
      message: "Métrica criada.",
    };
  } catch (error) {
    return operational(error, values.datasetId);
  }
}

export async function updateSemanticMetricAction(
  _previous: SemanticMetricActionState,
  formData: FormData,
): Promise<SemanticMetricActionState> {
  const values = editInput(formData, "update");
  const context = await trustedRequest();
  if (!values?.metricKey || !context)
    return { outcome: "INVALID_INPUT", message: "Dados inválidos." };
  try {
    const current = await editableReview(values.datasetId, context.workspaceId);
    if (current.outcome !== "EDITABLE") return notFound;
    const existing = current.review.metrics.find(
      (metric) => metric.metricKey === values.metricKey,
    );
    const expression = desired(current.review, values);
    if (!existing) return notFound;
    if (!expression)
      return {
        outcome: "INCOMPATIBLE_FIELDS",
        message:
          "Os campos selecionados não são compatíveis com este template.",
      };
    const id = await metricId(
      context.workspaceId,
      current.review.revision.id,
      values.metricKey,
    );
    if (!id) return notFound;
    const result = await updateMetric(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: current.review.revision.id,
      metricId: id,
      changes: {
        name: values.name,
        label: values.label,
        description: values.description,
        expression: expression.expression,
      },
    });
    if (result.outcome !== "UPDATED" && result.outcome !== "UNCHANGED")
      return failure(result);
    await editableReview(values.datasetId, context.workspaceId);
    refresh(values.datasetId);
    return {
      outcome: "SAVED",
      operation: result.outcome,
      message:
        result.outcome === "UPDATED"
          ? "Métrica atualizada."
          : "Nenhuma alteração.",
    };
  } catch (error) {
    return operational(error, values.datasetId);
  }
}

export async function removeSemanticMetricAction(
  _previous: SemanticMetricActionState,
  formData: FormData,
): Promise<SemanticMetricActionState> {
  const keys = ["datasetId", "metricKey", "confirmRemoval"];
  if (!exactValues(formData, keys)) return notFound;
  const datasetId = formData.get("datasetId");
  const metricKey = formData.get("metricKey");
  const confirmation = formData.get("confirmRemoval");
  const context = await trustedRequest();
  if (
    !context ||
    typeof datasetId !== "string" ||
    typeof metricKey !== "string" ||
    !validId(datasetId) ||
    !validId(metricKey) ||
    confirmation !== "true"
  )
    return notFound;
  try {
    const current = await editableReview(datasetId, context.workspaceId);
    if (current.outcome !== "EDITABLE") return notFound;
    const existing = current.review.metrics.find(
      (metric) => metric.metricKey === metricKey,
    );
    if (!existing)
      return { outcome: "REMOVED", message: "A métrica já estava removida." };
    const id = await metricId(
      context.workspaceId,
      current.review.revision.id,
      metricKey,
    );
    if (!id)
      return { outcome: "REMOVED", message: "A métrica já estava removida." };
    const result = await removeMetric(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: current.review.revision.id,
      metricId: id,
    });
    if (result.outcome === "REVISION_NOT_EDITABLE")
      return {
        outcome: "REVISION_NOT_EDITABLE",
        message: "O draft não é mais editável. Atualize a página.",
      };
    if (result.outcome === "NOT_FOUND") return notFound;
    await editableReview(datasetId, context.workspaceId);
    refresh(datasetId);
    return { outcome: "REMOVED", message: "Métrica removida." };
  } catch (error) {
    return operational(error, datasetId);
  }
}
