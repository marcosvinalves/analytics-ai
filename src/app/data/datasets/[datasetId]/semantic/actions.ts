"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { validId } from "@/modules/dataset/domain/dataset-detail";
import { initialSemanticModelName } from "@/modules/semantic/domain/semantic-onboarding";
import { createSemanticModelDraft } from "@/modules/semantic/infrastructure/create-semantic-model-draft";
import { readSemanticOnboardingReadiness } from "@/modules/semantic/infrastructure/read-semantic-onboarding";

const notFoundMessage = "Dataset não encontrado.";
const operationalMessage =
  "Não foi possível confirmar a preparação. Atualize a página antes de tentar novamente.";

export type CreateSemanticDraftActionState =
  | { outcome: "IDLE" }
  | { outcome: "NOT_FOUND"; message: string }
  | {
      outcome: "DATASET_NOT_READY";
      status: "PROCESSING" | "FAILED";
      message: string;
    }
  | { outcome: "CONFLICT" | "BROKEN"; message: string }
  | { outcome: "OPERATIONAL_FAILURE"; message: string };

function input(formData: FormData) {
  const keys = [...formData.keys()].filter(
    (key) => !key.startsWith("$ACTION_"),
  );
  if (
    keys.length !== 2 ||
    formData.getAll("datasetId").length !== 1 ||
    formData.getAll("datasetVersionId").length !== 1
  )
    return null;
  const datasetId = formData.get("datasetId");
  const datasetVersionId = formData.get("datasetVersionId");
  if (
    typeof datasetId !== "string" ||
    typeof datasetVersionId !== "string" ||
    !validId(datasetId) ||
    !validId(datasetVersionId)
  )
    return null;
  return { datasetId, datasetVersionId };
}

function refresh(datasetId: string) {
  try {
    revalidatePath(`/data/datasets/${datasetId}`);
    revalidatePath(`/data/datasets/${datasetId}/semantic`);
  } catch {
    console.error("SEMANTIC_ONBOARDING_REVALIDATION_FAILED");
  }
}

export async function createSemanticDraftAction(
  _previousState: CreateSemanticDraftActionState,
  formData: FormData,
): Promise<CreateSemanticDraftActionState> {
  const context = localUploadContext();
  const values = input(formData);
  if (!context || !values)
    return { outcome: "NOT_FOUND", message: notFoundMessage };

  const requestHeaders = await headers();
  if (
    requestHeaders.get("origin") !== context.origin ||
    requestHeaders.get("host") !== new URL(context.origin).host
  )
    return { outcome: "NOT_FOUND", message: notFoundMessage };

  let navigate = false;
  try {
    const pool = getMetadataPool();
    const readiness = await readSemanticOnboardingReadiness(pool, {
      workspaceId: context.workspaceId,
      datasetId: values.datasetId,
      datasetVersionId: values.datasetVersionId,
    });
    if (readiness.outcome === "NOT_FOUND")
      return { outcome: "NOT_FOUND", message: notFoundMessage };
    if (readiness.outcome === "OPERATIONAL_FAILURE")
      return { outcome: "OPERATIONAL_FAILURE", message: operationalMessage };
    if (readiness.outcome === "DATASET_NOT_READY") {
      refresh(values.datasetId);
      return {
        outcome: readiness.outcome,
        status: readiness.status,
        message:
          readiness.status === "PROCESSING"
            ? "Processe os dados antes de preparar a análise."
            : "Esta versão falhou e não pode iniciar a preparação.",
      };
    }
    if (readiness.outcome === "BROKEN")
      return {
        outcome: "BROKEN",
        message: "A configuração semântica não pôde ser lida com segurança.",
      };
    if (readiness.outcome === "PUBLISHED_ONLY")
      return {
        outcome: "CONFLICT",
        message: "Este Dataset já possui um modelo publicado.",
      };
    if (readiness.outcome === "DRAFT_AVAILABLE") {
      navigate = true;
    } else {
      const result = await createSemanticModelDraft(pool, {
        workspaceId: context.workspaceId,
        datasetId: values.datasetId,
        datasetVersionId: values.datasetVersionId,
        modelName: initialSemanticModelName(values.datasetId),
        label: readiness.dataset.name,
        description: null,
      });
      if (result.outcome === "CREATED" || result.outcome === "EXISTING") {
        navigate = true;
      } else if (result.outcome === "NOT_FOUND") {
        return { outcome: "NOT_FOUND", message: notFoundMessage };
      } else if (result.outcome === "VERSION_NOT_READY") {
        refresh(values.datasetId);
        return {
          outcome: "DATASET_NOT_READY",
          status: result.status,
          message:
            result.status === "PROCESSING"
              ? "Processe os dados antes de preparar a análise."
              : "Esta versão falhou e não pode iniciar a preparação.",
        };
      } else {
        refresh(values.datasetId);
        return {
          outcome: "CONFLICT",
          message:
            "Outra preparação já existe. Atualize a página para continuar com segurança.",
        };
      }
    }
  } catch {
    console.error("SEMANTIC_ONBOARDING_CREATE_FAILED");
    refresh(values.datasetId);
    return { outcome: "OPERATIONAL_FAILURE", message: operationalMessage };
  }

  if (navigate) {
    refresh(values.datasetId);
    redirect(
      `/data/datasets/${values.datasetId}/semantic?version=${values.datasetVersionId}`,
    );
  }
  return { outcome: "OPERATIONAL_FAILURE", message: operationalMessage };
}
