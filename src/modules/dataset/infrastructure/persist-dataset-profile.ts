import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { markDatasetVersionReady } from "./dataset-version-lifecycle.ts";
import {
  validateDatasetProfile,
  ProcessingOperationalError,
  type DatasetProfile,
} from "../domain/dataset-profile.ts";
import type {
  VersionScope,
  TransitionResult,
} from "../domain/dataset-version-lifecycle.ts";

export type VersionReference = {
  id: string;
  dataset_id: string;
  version_number: number;
  source_type: string;
  storage_namespace: string;
  storage_key: string;
  original_filename: string | null;
  size_bytes: string | null;
  created_at: Date;
  status: "PROCESSING" | "READY" | "FAILED";
};
export async function loadVersion(
  executor: Pool | PoolClient,
  scope: VersionScope,
  lock = false,
): Promise<VersionReference | undefined> {
  const result = await executor.query<VersionReference>(
    `SELECT v.id, v.dataset_id, v.version_number, v.source_type, v.storage_namespace, v.storage_key, v.original_filename, v.size_bytes, v.created_at, v.status
    FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id
    WHERE v.id = $1 AND d.workspace_id = $2 ${lock ? "FOR UPDATE OF v FOR SHARE OF d" : ""}`,
    [scope.datasetVersionId, scope.workspaceId],
  );
  return result.rows[0];
}

export async function persistDatasetProfile(
  pool: Pool,
  scope: VersionScope,
  expected: VersionReference,
  profile: DatasetProfile,
): Promise<TransitionResult> {
  validateDatasetProfile(profile);
  const client = await pool.connect();
  let commitStarted = false;
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const current = await loadVersion(client, scope, true);
    if (!current || current.status !== "PROCESSING") {
      await client.query("ROLLBACK");
      return current
        ? {
            outcome: "ALREADY_TERMINAL",
            status: current.status as "READY" | "FAILED",
          }
        : { outcome: "NOT_FOUND" };
    }
    if (!isDeepStrictEqual(current, expected))
      throw new ProcessingOperationalError();
    if (
      (
        await client.query(
          "SELECT 1 FROM app.dataset_columns WHERE dataset_version_id = $1 LIMIT 1",
          [current.id],
        )
      ).rowCount
    )
      throw new ProcessingOperationalError();
    for (const column of profile.columns) {
      await client.query(
        `INSERT INTO app.dataset_columns(dataset_version_id, physical_name, inferred_type, ordinal_position, nullable, null_count)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          current.id,
          column.physicalName,
          column.inferredType,
          column.ordinalPosition,
          column.nullable,
          column.nullCount.toString(),
        ],
      );
    }
    const result = await markDatasetVersionReady(client, {
      ...scope,
      rowCount: profile.rowCount,
      columnCount: profile.columns.length,
    });
    if (result.outcome !== "TRANSITIONED")
      throw new ProcessingOperationalError();
    commitStarted = true;
    await client.query("COMMIT");
    return result;
  } catch {
    discard = true;
    let rollbackConfirmed = false;
    if (!commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* Unknown outcome, never finalize FAILED. */
      }
    }
    throw new ProcessingOperationalError(commitStarted || !rollbackConfirmed);
  } finally {
    client.release(discard);
  }
}
