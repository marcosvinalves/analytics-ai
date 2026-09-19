import { randomUUID } from "node:crypto";
import { getMetadataPool } from "@/lib/db";
import { checkLocalUploadRequest } from "@/lib/local-upload-context";
import { storageConfig } from "@/lib/storage/config";
import { LocalRawStorage } from "@/lib/storage/local-raw-storage";
import { uploadDataset } from "@/modules/dataset/application/upload-dataset";
import { UploadError } from "@/modules/dataset/application/upload-errors";
import {
  insertUploadMetadata,
  resolveUploadWorkspace,
} from "@/modules/dataset/infrastructure/insert-upload-metadata";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const requestId = randomUUID();
  try {
    const { workspaceId } = await context.params;
    const local = checkLocalUploadRequest(workspaceId, request);
    const config = storageConfig();
    const pool = getMetadataPool();
    // Resolve organization in PostgreSQL. This local scaffold is NOT tenant authorization.
    const organizationId = await resolveUploadWorkspace(
      pool,
      local.workspaceId,
    );
    const result = await uploadDataset(request, {
      workspaceId: local.workspaceId,
      organizationId,
      storage: new LocalRawStorage(config.root),
      maxBytes: config.maxBytes,
      requestId,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
      persist: (metadata) => insertUploadMetadata(pool, metadata),
    });
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (!request.bodyUsed) await request.body?.cancel().catch(() => {});
    const safe =
      error instanceof UploadError
        ? error
        : new UploadError(
            "UPLOAD_FAILED",
            500,
            "Não foi possível concluir o upload.",
          );
    console.error(safe.code, requestId);
    return Response.json(
      { error: { code: safe.code, message: safe.message, requestId } },
      { status: safe.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
