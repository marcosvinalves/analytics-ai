import type { Pool } from "pg";
import type { RawObject } from "../../../lib/storage/raw-storage.ts";
import { UploadError } from "../application/upload-errors.ts";

export type UploadMetadata = {
  datasetId: string;
  versionId: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  originalFilename: string;
  sizeBytes: number;
  object: RawObject;
};

export async function resolveUploadWorkspace(
  pool: Pool,
  workspaceId: string,
): Promise<string> {
  try {
    const result = await pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM app.workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!result.rows[0])
      throw new UploadError(
        "UPLOAD_UNAVAILABLE",
        404,
        "Workspace local indisponível.",
      );
    return result.rows[0].organization_id;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError(
      "METADATA_WRITE_FAILED",
      503,
      "Banco de metadados indisponível.",
    );
  }
}

/** Only the SQL for this upload operation; no generic repository. */
export async function insertUploadMetadata(
  pool: Pool,
  input: UploadMetadata,
): Promise<void> {
  let client;
  let commitStarted = false;
  let rollbackConfirmed = false;
  let connected = false;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const workspace = await client.query(
      "SELECT id FROM app.workspaces WHERE id = $1 AND organization_id = $2 FOR SHARE",
      [input.workspaceId, input.organizationId],
    );
    if (!workspace.rowCount) throw new Error("Workspace changed");
    await client.query(
      "INSERT INTO app.datasets (id, workspace_id, name) VALUES ($1, $2, $3)",
      [input.datasetId, input.workspaceId, input.name],
    );
    await client.query(
      `INSERT INTO app.dataset_versions
      (id, dataset_id, version_number, source_type, storage_namespace, storage_key, status, original_filename, size_bytes)
      VALUES ($1, $2, 1, 'CSV', $3, $4, 'PROCESSING', $5, $6)`,
      [
        input.versionId,
        input.datasetId,
        input.object.namespace,
        input.object.key,
        input.originalFilename,
        input.sizeBytes,
      ],
    );
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return;
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* Preserve object if rollback cannot be confirmed. */
      }
    }
    client?.release(true);
    client = undefined;
    if (commitStarted) {
      // A fresh connection may prove success. Absence alone does not prove rollback.
      try {
        const result = await pool.query(
          `SELECT 1 FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id
          WHERE v.id = $1 AND d.id = $2 AND d.workspace_id = $3 AND v.storage_namespace = $4 AND v.storage_key = $5`,
          [
            input.versionId,
            input.datasetId,
            input.workspaceId,
            input.object.namespace,
            input.object.key,
          ],
        );
        if (result.rowCount === 1) return;
      } catch {
        /* Unknown outcome: never compensate by deleting raw data. */
      }
    }
    if (!connected || rollbackConfirmed) {
      throw new UploadError(
        "METADATA_WRITE_FAILED",
        503,
        "Não foi possível registrar o upload.",
        true,
      );
    }
    throw new UploadError(
      "UPLOAD_OUTCOME_UNKNOWN",
      503,
      "Não foi possível confirmar o resultado. Não repita automaticamente o envio.",
    );
  }
}
