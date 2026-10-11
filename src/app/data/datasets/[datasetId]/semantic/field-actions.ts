"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { validId } from "@/modules/dataset/domain/dataset-detail";
import {
  sameSemanticType,
  type SemanticFieldReviewColumn,
} from "@/modules/semantic/domain/semantic-field-review";
import type { SemanticType } from "@/modules/semantic/domain/semantic-field";
import { readSemanticFieldReview } from "@/modules/semantic/infrastructure/read-semantic-field-review";
import {
  createSemanticField,
  removeSemanticField,
  updateSemanticField,
} from "@/modules/semantic/infrastructure/semantic-fields";

export type SemanticFieldActionState =
  | { outcome: "IDLE" }
  | {
      outcome: "SAVED";
      operation: "CREATED" | "UPDATED" | "UNCHANGED";
      message: string;
    }
  | { outcome: "REMOVED"; message: string }
  | {
      outcome:
        | "EXPLICIT_CONVERSION_REQUIRED"
        | "INCOMPATIBLE_TYPE"
        | "FIELD_IN_USE"
        | "FIELD_CHANGE_INVALIDATES_METRIC"
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

type FieldValues = {
  datasetId: string;
  datasetColumnId: string;
  name: string;
  label: string;
  description: string | null;
  semanticType: SemanticType;
  acceptExplicitConversion: boolean;
};

const editableKeys = [
  "datasetId",
  "datasetColumnId",
  "name",
  "label",
  "description",
  "semanticType",
  "decimalPrecision",
  "decimalScale",
  "acceptExplicitConversion",
] as const;
const notFound = {
  outcome: "NOT_FOUND",
  message: "Revisão não encontrada.",
} as const;
const operationalMessage =
  "Não foi possível salvar o campo. Seus valores foram preservados para nova conferência.";
const unknownMessage =
  "Não foi possível confirmar o resultado. Atualize a página antes de tentar novamente.";

function exactValues(formData: FormData, keys: readonly string[]) {
  const actual = [...formData.keys()].filter(
    (key) => !key.startsWith("$ACTION_"),
  );
  return (
    actual.length === keys.length &&
    keys.every((key) => formData.getAll(key).length === 1)
  );
}

function semanticType(
  kind: string,
  precision: string,
  scale: string,
): SemanticType | null {
  const simple = new Set([
    "STRING",
    "BOOLEAN",
    "INTEGER",
    "NUMBER",
    "DATE",
    "DATETIME",
    "INSTANT",
  ]);
  if (simple.has(kind) && precision === "" && scale === "")
    return { kind } as SemanticType;
  if (
    kind !== "DECIMAL" ||
    !/^\d{1,2}$/.test(precision) ||
    !/^\d{1,2}$/.test(scale)
  )
    return null;
  const parsedPrecision = Number(precision);
  const parsedScale = Number(scale);
  return parsedPrecision >= 1 &&
    parsedPrecision <= 38 &&
    parsedScale >= 0 &&
    parsedScale <= parsedPrecision
    ? { kind: "DECIMAL", precision: parsedPrecision, scale: parsedScale }
    : null;
}

function editInput(formData: FormData): FieldValues | null {
  if (!exactValues(formData, editableKeys)) return null;
  const values = Object.fromEntries(
    editableKeys.map((key) => [key, formData.get(key)]),
  ) as Record<(typeof editableKeys)[number], FormDataEntryValue | null>;
  if (Object.values(values).some((value) => typeof value !== "string"))
    return null;
  const strings = values as Record<(typeof editableKeys)[number], string>;
  if (
    !validId(strings.datasetId) ||
    !validId(strings.datasetColumnId) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(strings.name) ||
    strings.label !== strings.label.trim() ||
    strings.label.length < 1 ||
    strings.label.length > 200 ||
    strings.description !== strings.description.trim() ||
    strings.description.length > 2000 ||
    !["true", "false"].includes(strings.acceptExplicitConversion)
  )
    return null;
  const parsedType = semanticType(
    strings.semanticType,
    strings.decimalPrecision,
    strings.decimalScale,
  );
  if (!parsedType) return null;
  return {
    datasetId: strings.datasetId,
    datasetColumnId: strings.datasetColumnId,
    name: strings.name,
    label: strings.label,
    description: strings.description || null,
    semanticType: parsedType,
    acceptExplicitConversion: strings.acceptExplicitConversion === "true",
  };
}

function sameField(column: SemanticFieldReviewColumn, values: FieldValues) {
  const field = column.field;
  return (
    field !== null &&
    field.name === values.name &&
    field.label === values.label &&
    field.description === values.description &&
    sameSemanticType(field.semanticType, values.semanticType)
  );
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
    console.error("SEMANTIC_FIELD_REVIEW_REVALIDATION_FAILED");
  }
}

async function editableColumn(
  datasetId: string,
  datasetColumnId: string,
  workspaceId: string,
) {
  const result = await readSemanticFieldReview(getMetadataPool(), {
    workspaceId,
    datasetId,
  });
  if (result.outcome !== "EDITABLE") return { result, column: undefined };
  return {
    result,
    column: result.review.columns.find(
      (candidate) => candidate.datasetColumnId === datasetColumnId,
    ),
  };
}

function mutationFailure(
  result:
    | Awaited<ReturnType<typeof createSemanticField>>
    | Awaited<ReturnType<typeof updateSemanticField>>,
): SemanticFieldActionState {
  switch (result.outcome) {
    case "EXPLICIT_CONVERSION_REQUIRED":
      return {
        outcome: result.outcome,
        message: "Confirme explicitamente esta interpretação antes de salvar.",
      };
    case "INCOMPATIBLE_TYPE":
      return {
        outcome: result.outcome,
        message: "O tipo físico não admite essa interpretação semântica.",
      };
    case "FIELD_CHANGE_INVALIDATES_METRIC":
      return {
        outcome: result.outcome,
        message: "Uma métrica existente impede esta alteração de tipo.",
      };
    case "REVISION_NOT_EDITABLE":
      return {
        outcome: result.outcome,
        message: "A revisão não é mais editável. Atualize a página.",
      };
    case "CONFLICT":
      return {
        outcome: result.outcome,
        message: "Outra alteração entrou em conflito. Atualize a página.",
      };
    case "NOT_FOUND":
      return notFound;
    default:
      return {
        outcome: "CONFLICT",
        message: "Não foi possível confirmar a alteração.",
      };
  }
}

function operational(
  error: unknown,
  datasetId?: string,
): SemanticFieldActionState {
  if (datasetId) refresh(datasetId);
  const unknown =
    error instanceof Error &&
    error.message === "SEMANTIC_FIELD_OUTCOME_UNKNOWN";
  return {
    outcome: "OPERATIONAL_FAILURE",
    code: unknown ? "OUTCOME_UNKNOWN" : "WRITE_FAILED",
    message: unknown ? unknownMessage : operationalMessage,
  };
}

export async function createSemanticFieldAction(
  _previous: SemanticFieldActionState,
  formData: FormData,
): Promise<SemanticFieldActionState> {
  const values = editInput(formData);
  const context = await trustedRequest();
  if (!values || !context) return notFound;
  try {
    const resolved = await editableColumn(
      values.datasetId,
      values.datasetColumnId,
      context.workspaceId,
    );
    if (resolved.result.outcome !== "EDITABLE" || !resolved.column)
      return notFound;
    if (resolved.column.field) {
      if (sameField(resolved.column, values))
        return {
          outcome: "SAVED",
          operation: "UNCHANGED",
          message: "Este campo já estava salvo.",
        };
      return {
        outcome: "CONFLICT",
        message: "A coluna já foi incluída com outra configuração.",
      };
    }
    const result = await createSemanticField(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: resolved.result.review.revision.id,
      datasetColumnId: values.datasetColumnId,
      name: values.name,
      label: values.label,
      description: values.description,
      semanticType: values.semanticType,
      acceptExplicitConversion: values.acceptExplicitConversion,
    });
    if (result.outcome !== "CREATED") {
      if (result.outcome === "CONFLICT") {
        const latest = await editableColumn(
          values.datasetId,
          values.datasetColumnId,
          context.workspaceId,
        );
        if (latest.column && sameField(latest.column, values)) {
          refresh(values.datasetId);
          return {
            outcome: "SAVED",
            operation: "UNCHANGED",
            message: "Este campo já estava salvo.",
          };
        }
      }
      return mutationFailure(result);
    }
    await editableColumn(
      values.datasetId,
      values.datasetColumnId,
      context.workspaceId,
    );
    refresh(values.datasetId);
    return {
      outcome: "SAVED",
      operation: "CREATED",
      message: "Campo incluído.",
    };
  } catch (error) {
    return operational(error, values.datasetId);
  }
}

export async function updateSemanticFieldAction(
  _previous: SemanticFieldActionState,
  formData: FormData,
): Promise<SemanticFieldActionState> {
  const values = editInput(formData);
  const context = await trustedRequest();
  if (!values || !context) return notFound;
  try {
    const resolved = await editableColumn(
      values.datasetId,
      values.datasetColumnId,
      context.workspaceId,
    );
    if (resolved.result.outcome !== "EDITABLE" || !resolved.column?.field)
      return notFound;
    const result = await updateSemanticField(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: resolved.result.review.revision.id,
      semanticFieldId: resolved.column.field.id,
      changes: {
        name: values.name,
        label: values.label,
        description: values.description,
        semanticType: values.semanticType,
        acceptExplicitConversion: values.acceptExplicitConversion,
      },
    });
    if (result.outcome !== "UPDATED" && result.outcome !== "UNCHANGED")
      return mutationFailure(result);
    await editableColumn(
      values.datasetId,
      values.datasetColumnId,
      context.workspaceId,
    );
    refresh(values.datasetId);
    return {
      outcome: "SAVED",
      operation: result.outcome,
      message:
        result.outcome === "UPDATED"
          ? "Campo atualizado."
          : "Nenhuma alteração.",
    };
  } catch (error) {
    return operational(error, values.datasetId);
  }
}

export async function removeSemanticFieldAction(
  _previous: SemanticFieldActionState,
  formData: FormData,
): Promise<SemanticFieldActionState> {
  const keys = ["datasetId", "datasetColumnId", "confirmRemoval"];
  if (!exactValues(formData, keys)) return notFound;
  const datasetId = formData.get("datasetId");
  const datasetColumnId = formData.get("datasetColumnId");
  const confirmation = formData.get("confirmRemoval");
  const context = await trustedRequest();
  if (
    !context ||
    typeof datasetId !== "string" ||
    typeof datasetColumnId !== "string" ||
    confirmation !== "true" ||
    !validId(datasetId) ||
    !validId(datasetColumnId)
  )
    return notFound;
  try {
    const resolved = await editableColumn(
      datasetId,
      datasetColumnId,
      context.workspaceId,
    );
    if (resolved.result.outcome !== "EDITABLE" || !resolved.column)
      return notFound;
    if (!resolved.column.field)
      return { outcome: "REMOVED", message: "O campo já estava removido." };
    const result = await removeSemanticField(getMetadataPool(), {
      workspaceId: context.workspaceId,
      semanticModelRevisionId: resolved.result.review.revision.id,
      semanticFieldId: resolved.column.field.id,
    });
    if (result.outcome === "FIELD_IN_USE")
      return {
        outcome: result.outcome,
        message: "Uma métrica existente impede a remoção deste campo.",
      };
    if (result.outcome === "REVISION_NOT_EDITABLE")
      return {
        outcome: result.outcome,
        message: "A revisão não é mais editável. Atualize a página.",
      };
    if (result.outcome === "NOT_FOUND") return notFound;
    await editableColumn(datasetId, datasetColumnId, context.workspaceId);
    refresh(datasetId);
    return {
      outcome: "REMOVED",
      message: "Campo removido. Uma recriação terá uma nova identidade.",
    };
  } catch (error) {
    return operational(error, datasetId);
  }
}
