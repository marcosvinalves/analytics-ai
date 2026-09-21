import "server-only";
import type { Pool } from "pg";
import {
  validId,
  type DatasetMetadata,
  type DatasetSelection,
} from "../domain/dataset-detail.ts";

export async function readDatasetMetadata(
  pool: Pool,
  scope: DatasetSelection,
): Promise<DatasetMetadata | null> {
  if (
    !validId(scope.workspaceId) ||
    !validId(scope.datasetId) ||
    (scope.versionId !== undefined && !validId(scope.versionId))
  )
    return null;
  const client = await pool.connect().catch(() => {
    throw new Error("DATASET_METADATA_UNAVAILABLE");
  });
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await client.query(
      `SELECT d.id AS dataset_id, d.name, d.description, v.*
      FROM app.datasets d JOIN app.dataset_versions v ON v.dataset_id=d.id
      WHERE d.workspace_id=$1 AND d.id=$2 AND ($3::uuid IS NULL OR v.id=$3)
      ORDER BY v.version_number DESC LIMIT 1`,
      [scope.workspaceId, scope.datasetId, scope.versionId ?? null],
    );
    const v = result.rows[0];
    if (!v) {
      await client.query("COMMIT");
      return null;
    }
    const columns = await client.query(
      `SELECT physical_name AS "physicalName", inferred_type AS "inferredType",
      ordinal_position AS "ordinalPosition", nullable, null_count::text AS "nullCount"
      FROM app.dataset_columns WHERE dataset_version_id=$1 ORDER BY ordinal_position`,
      [v.id],
    );
    await client.query("COMMIT");
    return {
      detail: {
        dataset: { id: v.dataset_id, name: v.name, description: v.description },
        version: {
          id: v.id,
          versionNumber: v.version_number,
          status: v.status,
          rowCount: v.row_count,
          columnCount: v.column_count,
          originalFilename: v.original_filename,
          sizeBytes: v.size_bytes,
          processedAt: v.processed_at?.toISOString() ?? null,
        },
        columns: columns.rows,
        preview: { state: "UNAVAILABLE" },
      },
      raw: {
        namespace: v.storage_namespace,
        key: v.storage_key,
        sizeBytes: v.size_bytes,
        sourceType: v.source_type,
      },
    };
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw new Error("DATASET_METADATA_UNAVAILABLE");
  } finally {
    client.release(discard);
  }
}

export async function listDatasets(
  pool: Pool,
  workspaceId: string,
): Promise<
  {
    id: string;
    name: string;
    status: string | null;
    versionNumber: number | null;
  }[]
> {
  if (!validId(workspaceId)) return [];
  try {
    return (
      await pool.query(
        `SELECT d.id,d.name,v.status,v.version_number AS "versionNumber"
      FROM app.datasets d LEFT JOIN LATERAL (SELECT status,version_number FROM app.dataset_versions
      WHERE dataset_id=d.id ORDER BY version_number DESC LIMIT 1) v ON true
      WHERE d.workspace_id=$1 ORDER BY d.created_at DESC,d.id LIMIT 50`,
        [workspaceId],
      )
    ).rows;
  } catch {
    throw new Error("DATASET_METADATA_UNAVAILABLE");
  }
}
