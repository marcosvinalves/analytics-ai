import type { Pool, PoolClient } from "pg";
import {
  semanticTypeFromStorage,
  type SemanticType,
} from "../domain/semantic-field.ts";
import type {
  DatasetVersionStatus,
  SemanticModelRevisionSnapshot,
  SemanticRevisionStatus,
} from "../domain/semantic-model.ts";
import {
  validateSemanticPublicationScope,
  validateSemanticRevisionContent,
  type PublishSemanticModelRevisionResult,
  type SemanticContentField,
  type SemanticContentMetric,
  type SemanticPublicationScope,
  type SemanticRevisionContent,
  type ValidateSemanticModelRevisionResult,
} from "../domain/semantic-publication.ts";

type RevisionRow = {
  id: string;
  semantic_model_id: string;
  dataset_version_id: string;
  revision_number: number;
  status: SemanticRevisionStatus;
  label: string;
  description: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  model_dataset_id: string;
  version_dataset_id: string;
  dataset_version_status: DatasetVersionStatus;
};

type FieldRow = {
  field_key: string;
  field_dataset_version_id: string;
  semantic_type: string;
  decimal_precision: number | null;
  decimal_scale: number | null;
  column_id: string | null;
  column_dataset_version_id: string | null;
  inferred_type: string | null;
};

type MetricRow = {
  id: string;
  metric_key: string;
  expression: unknown;
};

const revisionColumns = `r.id, r.semantic_model_id, r.dataset_version_id,
  r.revision_number, r.status, r.label, r.description, r.published_at,
  r.created_at, r.updated_at, m.dataset_id AS model_dataset_id,
  v.dataset_id AS version_dataset_id, v.status AS dataset_version_status`;

function revisionSnapshot(row: RevisionRow): SemanticModelRevisionSnapshot {
  return {
    id: row.id,
    semanticModelId: row.semantic_model_id,
    datasetVersionId: row.dataset_version_id,
    revisionNumber: row.revision_number,
    status: row.status,
    label: row.label,
    description: row.description,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadScopedRevision(
  client: Pick<PoolClient, "query">,
  scope: SemanticPublicationScope,
  lock: boolean,
): Promise<RevisionRow | undefined> {
  return (
    await client.query<RevisionRow>(
      `SELECT ${revisionColumns}
       FROM app.semantic_model_revisions r
       JOIN app.semantic_models m ON m.id = r.semantic_model_id
       JOIN app.datasets d ON d.id = m.dataset_id
       JOIN app.dataset_versions v ON v.id = r.dataset_version_id
       WHERE r.id = $1 AND d.workspace_id = $2
       ${lock ? "FOR UPDATE OF r" : ""}`,
      [scope.semanticModelRevisionId, scope.workspaceId],
    )
  ).rows[0];
}

function semanticType(row: FieldRow): SemanticType | null {
  try {
    return semanticTypeFromStorage(
      row.semantic_type,
      row.decimal_precision,
      row.decimal_scale,
    );
  } catch {
    return null;
  }
}

async function loadContent(
  client: Pick<PoolClient, "query">,
  revision: RevisionRow,
): Promise<SemanticRevisionContent> {
  const fieldRows = (
    await client.query<FieldRow>(
      `SELECT f.field_key, f.dataset_version_id AS field_dataset_version_id,
        f.semantic_type, f.decimal_precision, f.decimal_scale,
        c.id AS column_id, c.dataset_version_id AS column_dataset_version_id,
        c.inferred_type
       FROM app.semantic_fields f
       LEFT JOIN app.dataset_columns c
         ON c.id = f.dataset_column_id
        AND c.dataset_version_id = f.dataset_version_id
       WHERE f.semantic_model_revision_id = $1
       ORDER BY f.field_key`,
      [revision.id],
    )
  ).rows;
  const metricRows = (
    await client.query<MetricRow>(
      `SELECT id, metric_key, expression FROM app.metrics
       WHERE semantic_model_revision_id = $1 ORDER BY metric_key`,
      [revision.id],
    )
  ).rows;
  const referenceRows = (
    await client.query<{ metric_id: string; field_key: string }>(
      `SELECT metric_id, field_key FROM app.metric_field_references
       WHERE semantic_model_revision_id = $1 ORDER BY metric_id, field_key`,
      [revision.id],
    )
  ).rows;
  const references = new Map<string, string[]>();
  for (const row of referenceRows)
    references.set(row.metric_id, [
      ...(references.get(row.metric_id) ?? []),
      row.field_key,
    ]);
  const fields: SemanticContentField[] = fieldRows.map((row) => ({
    fieldKey: row.field_key,
    physicalType: row.inferred_type,
    semanticType: semanticType(row),
    lineageValid:
      row.column_id !== null &&
      row.field_dataset_version_id === revision.dataset_version_id &&
      row.column_dataset_version_id === revision.dataset_version_id,
  }));
  const metrics: SemanticContentMetric[] = metricRows.map((row) => ({
    metricKey: row.metric_key,
    expression: row.expression,
    projectedFieldKeys: references.get(row.id) ?? [],
  }));
  return {
    sameDataset: revision.model_dataset_id === revision.version_dataset_id,
    datasetVersionStatus: revision.dataset_version_status,
    fields,
    metrics,
  };
}

export async function validateSemanticModelRevision(
  pool: Pool,
  input: SemanticPublicationScope,
): Promise<ValidateSemanticModelRevisionResult> {
  validateSemanticPublicationScope(input);
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = await loadScopedRevision(client, input, false);
    if (!revision) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    if (revision.status !== "DRAFT") {
      await client.query("ROLLBACK");
      return { outcome: "REVISION_NOT_DRAFT", status: revision.status };
    }
    const validation = validateSemanticRevisionContent(
      await loadContent(client, revision),
    );
    await client.query("COMMIT");
    return validation.issues.length
      ? { outcome: "INVALID", ...validation }
      : {
          outcome: "VALID",
          fieldCount: validation.fieldCount,
          metricCount: validation.metricCount,
        };
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Unknown read transaction state. */
    }
    return { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}

async function reconcilePublication(
  pool: Pool,
  input: SemanticPublicationScope,
  archivedRevisionId: string | null,
): Promise<PublishSemanticModelRevisionResult> {
  try {
    const revision = await loadScopedRevision(pool, input, false);
    if (revision?.status === "PUBLISHED")
      return {
        outcome: "PUBLISHED",
        revision: revisionSnapshot(revision),
        archivedRevisionId,
      };
    if (revision?.status === "DRAFT") return { outcome: "OPERATIONAL_FAILURE" };
  } catch {
    /* The publication outcome cannot be inferred. */
  }
  return { outcome: "PUBLICATION_OUTCOME_UNKNOWN" };
}

async function finishPublication<T>(client: PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  client.release();
  return result;
}

export async function publishSemanticModelRevision(
  pool: Pool,
  input: SemanticPublicationScope,
): Promise<PublishSemanticModelRevisionResult> {
  validateSemanticPublicationScope(input);
  let client: PoolClient | undefined;
  let commitStarted = false;
  let archivedRevisionId: string | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const initial = await loadScopedRevision(client, input, false);
    if (!initial)
      return await finishPublication(client, { outcome: "NOT_FOUND" });
    await client.query(
      "SELECT id FROM app.semantic_models WHERE id = $1 FOR UPDATE",
      [initial.semantic_model_id],
    );
    const revision = await loadScopedRevision(client, input, true);
    if (!revision || revision.semantic_model_id !== initial.semantic_model_id)
      return await finishPublication(client, { outcome: "NOT_FOUND" });
    if (revision.status === "PUBLISHED") {
      return await finishPublication(client, {
        outcome: "ALREADY_PUBLISHED",
        revision: revisionSnapshot(revision),
      });
    }
    if (revision.status === "ARCHIVED")
      return await finishPublication(client, {
        outcome: "REVISION_NOT_DRAFT",
        status: "ARCHIVED",
      });
    const current = (
      await client.query<{ id: string }>(
        `SELECT id FROM app.semantic_model_revisions
         WHERE semantic_model_id = $1 AND status = 'PUBLISHED' AND id <> $2
         FOR UPDATE`,
        [revision.semantic_model_id, revision.id],
      )
    ).rows[0];
    archivedRevisionId = current?.id ?? null;
    const validation = validateSemanticRevisionContent(
      await loadContent(client, revision),
    );
    if (validation.issues.length) {
      return await finishPublication(client, {
        outcome: "VALIDATION_FAILED",
        ...validation,
      });
    }
    if (current)
      await client.query(
        "UPDATE app.semantic_model_revisions SET status = 'ARCHIVED' WHERE id = $1",
        [current.id],
      );
    const published = (
      await client.query<RevisionRow>(
        `UPDATE app.semantic_model_revisions
         SET status = 'PUBLISHED', published_at = transaction_timestamp()
         WHERE id = $1 RETURNING *,
           $2::uuid AS model_dataset_id,
           $2::uuid AS version_dataset_id,
           'READY'::text AS dataset_version_status`,
        [revision.id, revision.model_dataset_id],
      )
    ).rows[0];
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return {
      outcome: "PUBLISHED",
      revision: revisionSnapshot(published),
      archivedRevisionId,
    };
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* Unknown transaction state. */
      }
    }
    client?.release(true);
    if (commitStarted)
      return reconcilePublication(pool, input, archivedRevisionId);
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}
