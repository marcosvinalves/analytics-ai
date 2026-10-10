"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { processDatasetVersion } from "@/modules/dataset/application/process-dataset-version";
import { validId } from "@/modules/dataset/domain/dataset-detail";
import { readDatasetMetadata } from "@/modules/dataset/infrastructure/read-dataset-metadata";

const operationalMessage =
  "Não foi possível concluir o processamento. Verifique o estado antes de tentar novamente.";
const unknownMessage =
  "Não foi possível confirmar o resultado. Atualize a página antes de tentar novamente.";

export type ProcessDatasetActionState =
  | { outcome: "IDLE" }
  | {
      outcome: "TRANSITIONED";
      status: "READY" | "FAILED";
      message: string;
    }
  | {
      outcome: "ALREADY_TERMINAL";
      status: "READY" | "FAILED";
      message: string;
    }
  | { outcome: "NOT_FOUND"; message: string }
  | {
      outcome: "OPERATIONAL_FAILURE";
      code: "PROCESSING_OPERATIONAL_FAILURE" | "PROCESSING_OUTCOME_UNKNOWN";
      message: string;
    };

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

function terminalMessage(status: "READY" | "FAILED") {
  return status === "READY"
    ? "Dados processados. Schema e preview estão disponíveis."
    : "Não foi possível processar este arquivo.";
}

function refresh(datasetId: string) {
  try {
    revalidatePath(`/data/datasets/${datasetId}`);
  } catch {
    console.error("DATASET_PROCESSING_REVALIDATION_FAILED");
  }
}

export async function processDatasetAction(
  _previousState: ProcessDatasetActionState,
  formData: FormData,
): Promise<ProcessDatasetActionState> {
  const context = localUploadContext();
  const values = input(formData);
  if (!context || !values)
    return { outcome: "NOT_FOUND", message: "Dataset não encontrado." };

  const requestHeaders = await headers();
  if (
    requestHeaders.get("origin") !== context.origin ||
    requestHeaders.get("host") !== new URL(context.origin).host
  )
    return { outcome: "NOT_FOUND", message: "Dataset não encontrado." };

  try {
    const pool = getMetadataPool();
    const metadata = await readDatasetMetadata(pool, {
      workspaceId: context.workspaceId,
      datasetId: values.datasetId,
      versionId: values.datasetVersionId,
    });
    if (!metadata)
      return { outcome: "NOT_FOUND", message: "Dataset não encontrado." };

    if (metadata.detail.version.status !== "PROCESSING") {
      const status = metadata.detail.version.status;
      refresh(values.datasetId);
      return {
        outcome: "ALREADY_TERMINAL",
        status,
        message: terminalMessage(status),
      };
    }

    const result = await processDatasetVersion(pool, {
      workspaceId: context.workspaceId,
      datasetVersionId: values.datasetVersionId,
    });
    if (result.outcome === "TRANSITIONED") {
      refresh(values.datasetId);
      return {
        outcome: result.outcome,
        status: result.version.status,
        message: terminalMessage(result.version.status),
      };
    }
    if (result.outcome === "ALREADY_TERMINAL") {
      refresh(values.datasetId);
      return {
        outcome: result.outcome,
        status: result.status,
        message: terminalMessage(result.status),
      };
    }
    if (result.outcome === "NOT_FOUND")
      return { outcome: "NOT_FOUND", message: "Dataset não encontrado." };

    if (result.code === "PROCESSING_OUTCOME_UNKNOWN") refresh(values.datasetId);
    return {
      outcome: result.outcome,
      code: result.code,
      message:
        result.code === "PROCESSING_OUTCOME_UNKNOWN"
          ? unknownMessage
          : operationalMessage,
    };
  } catch {
    console.error("DATASET_PROCESSING_ACTION_FAILED");
    return {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OPERATIONAL_FAILURE",
      message: operationalMessage,
    };
  }
}
