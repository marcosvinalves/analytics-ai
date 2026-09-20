import type { Pool } from "pg";
import {
  validateReady,
  validateFailed,
  type ReadyInput,
  type FailedInput,
  type VersionScope,
  type TransitionResult,
  type LifecycleSnapshot,
} from "../domain/dataset-version-lifecycle.ts";

type Row = {
  id: string;
  status: "READY" | "FAILED";
  row_count: string | null;
  column_count: number | null;
  processing_error_code: string | null;
  processing_error_message: string | null;
  processed_at: Date;
  updated_at: Date;
};
const scopeSql = `v.id = $1 AND EXISTS (
  SELECT 1 FROM app.datasets d WHERE d.id = v.dataset_id AND d.workspace_id = $2
)`;
const returningSql = `RETURNING v.id, v.status, v.row_count, v.column_count,
  v.processing_error_code, v.processing_error_message, v.processed_at, v.updated_at`;

function snapshot(row: Row): LifecycleSnapshot {
  return {
    id: row.id,
    status: row.status,
    rowCount: row.row_count === null ? null : BigInt(row.row_count),
    columnCount: row.column_count,
    processingErrorCode: row.processing_error_code,
    processingErrorMessage: row.processing_error_message,
    processedAt: row.processed_at,
    updatedAt: row.updated_at,
  };
}
async function classify(
  pool: Pool,
  input: VersionScope,
  row?: Row,
): Promise<TransitionResult> {
  if (row) return { outcome: "TRANSITIONED", version: snapshot(row) };
  // Separate statement sees the competing writer's committed result. Never authorizes a retry.
  const result = await pool.query<{ status: string }>(
    `SELECT v.status FROM app.dataset_versions v WHERE ${scopeSql}`,
    [input.datasetVersionId, input.workspaceId],
  );
  if (!result.rows[0]) return { outcome: "NOT_FOUND" };
  const status = result.rows[0].status;
  if (status === "READY" || status === "FAILED")
    return { outcome: "ALREADY_TERMINAL", status };
  throw new Error("Lifecycle invariant violated");
}

/** Internal metadata operation. Workspace scope is NOT authorization. Use an autocommit READ COMMITTED pool. */
export async function markDatasetVersionReady(
  pool: Pool,
  input: ReadyInput,
): Promise<TransitionResult> {
  validateReady(input);
  try {
    const result = await pool.query<Row>(
      `UPDATE app.dataset_versions v
      SET status = 'READY', row_count = $3, column_count = $4,
          processed_at = statement_timestamp(), processing_error_code = NULL, processing_error_message = NULL
      WHERE ${scopeSql} AND v.status = 'PROCESSING' ${returningSql}`,
      [
        input.datasetVersionId,
        input.workspaceId,
        input.rowCount.toString(),
        input.columnCount,
      ],
    );
    return await classify(pool, input, result.rows[0]);
  } catch {
    // A connection failure can occur after commit. Do not retry or mark FAILED automatically.
    throw new Error(
      "LIFECYCLE_OUTCOME_UNKNOWN: não foi possível confirmar a finalização da versão.",
    );
  }
}
export async function markDatasetVersionFailed(
  pool: Pool,
  input: FailedInput,
): Promise<TransitionResult> {
  validateFailed(input);
  try {
    const result = await pool.query<Row>(
      `UPDATE app.dataset_versions v
      SET status = 'FAILED', processing_error_code = $3, processing_error_message = $4,
          processed_at = statement_timestamp()
      WHERE ${scopeSql} AND v.status = 'PROCESSING' ${returningSql}`,
      [
        input.datasetVersionId,
        input.workspaceId,
        input.errorCode,
        input.errorMessage ?? null,
      ],
    );
    return await classify(pool, input, result.rows[0]);
  } catch {
    throw new Error(
      "LIFECYCLE_OUTCOME_UNKNOWN: não foi possível confirmar a finalização da versão.",
    );
  }
}
