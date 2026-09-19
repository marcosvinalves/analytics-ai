import { randomUUID } from "node:crypto";
import type { RawStorage } from "../../../lib/storage/raw-storage.ts";
import { rawStorageKey } from "../../../lib/storage/key.ts";
import { receiveMultipart } from "../infrastructure/receive-multipart.ts";
import type { UploadMetadata } from "../infrastructure/insert-upload-metadata.ts";
import { UploadError, storageFailure } from "./upload-errors.ts";

export async function uploadDataset(
  request: Request,
  input: {
    workspaceId: string;
    organizationId: string;
    storage: RawStorage;
    maxBytes: number;
    persist: (metadata: UploadMetadata) => Promise<void>;
    signal: AbortSignal;
    requestId: string;
  },
) {
  const received = await receiveMultipart(
    request,
    input.storage,
    input.maxBytes,
    input.signal,
  );
  const datasetId = randomUUID();
  const versionId = randomUUID();
  let object;
  try {
    input.signal.throwIfAborted();
    object = await input.storage.publishOnce(
      received.staged,
      rawStorageKey(input.workspaceId, versionId),
    );
  } catch {
    await input.storage
      .discard(received.staged)
      .catch(() => console.error("RAW_STAGE_CLEANUP_FAILED", input.requestId));
    throw storageFailure();
  }
  try {
    await input.persist({
      datasetId,
      versionId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      name: received.name,
      originalFilename: received.originalFilename,
      sizeBytes: received.staged.sizeBytes,
      object,
    });
  } catch (error) {
    if (error instanceof UploadError && error.cleanupAllowed) {
      await input.storage
        .remove(object)
        .catch(() =>
          console.error("RAW_COMPENSATION_FAILED", input.requestId, versionId),
        );
    } else
      console.error("RAW_RECONCILIATION_REQUIRED", input.requestId, versionId);
    throw error instanceof UploadError
      ? error
      : new UploadError(
          "UPLOAD_OUTCOME_UNKNOWN",
          503,
          "Resultado do upload não confirmado. Não repita automaticamente.",
        );
  }
  return {
    dataset: {
      id: datasetId,
      workspaceId: input.workspaceId,
      name: received.name,
    },
    version: {
      id: versionId,
      versionNumber: 1,
      sourceType: "CSV",
      status: "PROCESSING",
      originalFilename: received.originalFilename,
      sizeBytes: received.staged.sizeBytes,
    },
  };
}
