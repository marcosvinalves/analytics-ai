import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  semanticTypeFromStorage,
  type SemanticType,
} from "../domain/semantic-field.ts";
import {
  validateMetricExpression,
  type ValidatedMetricExpression,
} from "../domain/metric-expression.ts";
import {
  validateCreateMetricInput,
  validateListMetricsInput,
  validateRemoveMetricInput,
  validateUpdateMetricInput,
  type CreateMetricInput,
  type CreateMetricResult,
  type ListMetricsResult,
  type MetricScope,
  type MetricSnapshot,
  type RemoveMetricInput,
  type RemoveMetricResult,
  type UpdateMetricInput,
  type UpdateMetricResult,
} from "../domain/metric.ts";
import type { SemanticRevisionStatus } from "../domain/semantic-model.ts";

type RevisionRow = {
  id: string;
  status: SemanticRevisionStatus;
};
type FieldRow = {
  field_key: string;
  semantic_type: string;
  decimal_precision: number | null;
  decimal_scale: number | null;
};
type MetricRow = {
  id: string;
  metric_key: string;
  semantic_model_revision_id: string;
  name: string;
  label: string;
  description: string | null;
  expression: unknown;
  created_at: Date;
  updated_at: Date;
};

type DesiredMetric = {
  name: string;
  label: string;
  description: string | null;
  validated: ValidatedMetricExpression;
};

async function loadRevision(
  client: PoolClient,
  scope: MetricScope,
  lock: boolean,
): Promise<RevisionRow | undefined> {
  return (
    await client.query<RevisionRow>(
      `SELECT r.id, r.status
       FROM app.semantic_model_revisions r
       JOIN app.semantic_models m ON m.id = r.semantic_model_id
       JOIN app.datasets d ON d.id = m.dataset_id
       WHERE r.id = $1 AND d.workspace_id = $2
       ${lock ? "FOR UPDATE OF r" : ""}`,
      [scope.semanticModelRevisionId, scope.workspaceId],
    )
  ).rows[0];
}

async function loadFieldTypes(
  client: Pick<PoolClient, "query">,
  revisionId: string,
): Promise<Map<string, SemanticType>> {
  const rows = (
    await client.query<FieldRow>(
      `SELECT field_key, semantic_type, decimal_precision, decimal_scale
       FROM app.semantic_fields
       WHERE semantic_model_revision_id = $1`,
      [revisionId],
    )
  ).rows;
  return new Map(
    rows.map((row) => [
      row.field_key,
      semanticTypeFromStorage(
        row.semantic_type,
        row.decimal_precision,
        row.decimal_scale,
      ),
    ]),
  );
}

function snapshot(
  row: MetricRow,
  fields: ReadonlyMap<string, SemanticType>,
): MetricSnapshot {
  const validated = validateMetricExpression(row.expression, fields);
  if (!validated.valid) throw new Error("METRIC_STORED_EXPRESSION_INVALID");
  return {
    id: row.id,
    metricKey: row.metric_key,
    semanticModelRevisionId: row.semantic_model_revision_id,
    name: row.name,
    label: row.label,
    description: row.description,
    expression: validated.value.expression,
    resultType: validated.value.resultType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function notEditable(status: SemanticRevisionStatus) {
  return status === "DRAFT"
    ? undefined
    : { outcome: "REVISION_NOT_EDITABLE" as const, status };
}

async function finish<T>(client: PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  client.release();
  return result;
}

async function replaceReferences(
  client: PoolClient,
  metricId: string,
  revisionId: string,
  fieldKeys: string[],
): Promise<void> {
  await client.query(
    "DELETE FROM app.metric_field_references WHERE metric_id = $1",
    [metricId],
  );
  if (!fieldKeys.length) return;
  await client.query(
    `INSERT INTO app.metric_field_references
       (metric_id, semantic_model_revision_id, field_key)
     SELECT $1, $2, key FROM unnest($3::uuid[]) AS key`,
    [metricId, revisionId, fieldKeys],
  );
}

function conflict(error: unknown) {
  if (!error || typeof error !== "object" || !("constraint" in error))
    return undefined;
  switch ((error as { constraint?: unknown }).constraint) {
    case "metrics_name_unique":
      return "NAME_ALREADY_EXISTS" as const;
    case "metrics_key_unique":
      return "METRIC_KEY_ALREADY_EXISTS" as const;
    default:
      return undefined;
  }
}

function sameDesired(metric: MetricSnapshot, desired: DesiredMetric): boolean {
  return (
    metric.name === desired.name &&
    metric.label === desired.label &&
    metric.description === desired.description &&
    JSON.stringify(metric.expression) === desired.validated.canonicalJson
  );
}

async function reconcileMetric(
  pool: Pool,
  workspaceId: string,
  metricId: string,
  desired: DesiredMetric,
): Promise<MetricSnapshot | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = (
      await client.query<MetricRow>(
        `SELECT m.* FROM app.metrics m
         JOIN app.semantic_model_revisions r ON r.id = m.semantic_model_revision_id
         JOIN app.semantic_models sm ON sm.id = r.semantic_model_id
         JOIN app.datasets d ON d.id = sm.dataset_id
         WHERE m.id = $1 AND d.workspace_id = $2`,
        [metricId, workspaceId],
      )
    ).rows[0];
    if (!row) {
      await client.query("COMMIT");
      return undefined;
    }
    const fields = await loadFieldTypes(client, row.semantic_model_revision_id);
    const metric = snapshot(row, fields);
    const references = (
      await client.query<{ field_key: string }>(
        `SELECT field_key FROM app.metric_field_references
         WHERE metric_id = $1 ORDER BY field_key`,
        [metricId],
      )
    ).rows.map((item) => item.field_key);
    await client.query("COMMIT");
    return sameDesired(metric, desired) &&
      JSON.stringify(references) === JSON.stringify(desired.validated.fieldKeys)
      ? metric
      : undefined;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Read-only reconciliation state is unknown. */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createMetric(
  pool: Pool,
  input: CreateMetricInput,
): Promise<CreateMetricResult> {
  validateCreateMetricInput(input);
  const id = randomUUID();
  const metricKey = randomUUID();
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  let desired: DesiredMetric | undefined;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input, true);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const blocked = notEditable(revision.status);
    if (blocked) return await finish(client, blocked);
    const fields = await loadFieldTypes(client, revision.id);
    const validated = validateMetricExpression(input.expression, fields);
    if (!validated.valid)
      return await finish(client, {
        outcome: "INVALID_EXPRESSION",
        error: validated.error,
      });
    desired = {
      name: input.name,
      label: input.label,
      description: input.description ?? null,
      validated: validated.value,
    };
    let row: MetricRow;
    try {
      row = (
        await client.query<MetricRow>(
          `INSERT INTO app.metrics
             (id, metric_key, semantic_model_revision_id, name, label,
              description, expression)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           RETURNING *`,
          [
            id,
            metricKey,
            revision.id,
            desired.name,
            desired.label,
            desired.description,
            desired.validated.canonicalJson,
          ],
        )
      ).rows[0];
      await replaceReferences(
        client,
        id,
        revision.id,
        desired.validated.fieldKeys,
      );
    } catch (error) {
      const reason = conflict(error);
      if (reason) return await finish(client, { outcome: "CONFLICT", reason });
      throw error;
    }
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return { outcome: "CREATED", metric: snapshot(row, fields) };
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* Unknown connection state. */
      }
    }
    client?.release(true);
    if (commitStarted && desired) {
      try {
        const persisted = await reconcileMetric(
          pool,
          input.workspaceId,
          id,
          desired,
        );
        if (persisted) return { outcome: "CREATED", metric: persisted };
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("METRIC_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected) throw new Error("METRIC_WRITE_FAILED");
    throw new Error("METRIC_OUTCOME_UNKNOWN");
  }
}

export async function updateMetric(
  pool: Pool,
  input: UpdateMetricInput,
): Promise<UpdateMetricResult> {
  validateUpdateMetricInput(input);
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  let desired: DesiredMetric | undefined;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input, true);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const blocked = notEditable(revision.status);
    if (blocked) return await finish(client, blocked);
    const fields = await loadFieldTypes(client, revision.id);
    const row = (
      await client.query<MetricRow>(
        `SELECT * FROM app.metrics
         WHERE id = $1 AND semantic_model_revision_id = $2`,
        [input.metricId, revision.id],
      )
    ).rows[0];
    if (!row) return await finish(client, { outcome: "NOT_FOUND" });
    const current = snapshot(row, fields);
    const expression =
      "expression" in input.changes
        ? input.changes.expression
        : current.expression;
    const validated = validateMetricExpression(expression, fields);
    if (!validated.valid)
      return await finish(client, {
        outcome: "INVALID_EXPRESSION",
        error: validated.error,
      });
    desired = {
      name: input.changes.name ?? current.name,
      label: input.changes.label ?? current.label,
      description:
        "description" in input.changes
          ? (input.changes.description ?? null)
          : current.description,
      validated: validated.value,
    };
    if (sameDesired(current, desired))
      return await finish(client, { outcome: "UNCHANGED", metric: current });
    let updated: MetricRow;
    try {
      updated = (
        await client.query<MetricRow>(
          `UPDATE app.metrics
           SET name = $3, label = $4, description = $5, expression = $6::jsonb
           WHERE id = $1 AND semantic_model_revision_id = $2
           RETURNING *`,
          [
            current.id,
            revision.id,
            desired.name,
            desired.label,
            desired.description,
            desired.validated.canonicalJson,
          ],
        )
      ).rows[0];
      await replaceReferences(
        client,
        current.id,
        revision.id,
        desired.validated.fieldKeys,
      );
    } catch (error) {
      const reason = conflict(error);
      if (reason) return await finish(client, { outcome: "CONFLICT", reason });
      throw error;
    }
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return { outcome: "UPDATED", metric: snapshot(updated, fields) };
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* Unknown connection state. */
      }
    }
    client?.release(true);
    if (commitStarted && desired) {
      try {
        const persisted = await reconcileMetric(
          pool,
          input.workspaceId,
          input.metricId,
          desired,
        );
        if (persisted) return { outcome: "UPDATED", metric: persisted };
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("METRIC_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected) throw new Error("METRIC_WRITE_FAILED");
    throw new Error("METRIC_OUTCOME_UNKNOWN");
  }
}

export async function removeMetric(
  pool: Pool,
  input: RemoveMetricInput,
): Promise<RemoveMetricResult> {
  validateRemoveMetricInput(input);
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input, true);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const blocked = notEditable(revision.status);
    if (blocked) return await finish(client, blocked);
    await client.query(
      `DELETE FROM app.metric_field_references
       WHERE metric_id = $1 AND semantic_model_revision_id = $2`,
      [input.metricId, revision.id],
    );
    const removed = await client.query(
      `DELETE FROM app.metrics
       WHERE id = $1 AND semantic_model_revision_id = $2`,
      [input.metricId, revision.id],
    );
    if (!removed.rowCount)
      return await finish(client, { outcome: "NOT_FOUND" });
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return { outcome: "REMOVED" };
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* Unknown connection state. */
      }
    }
    client?.release(true);
    if (commitStarted) {
      try {
        const persisted = await pool.query(
          `SELECT 1 FROM app.metrics m
           JOIN app.semantic_model_revisions r ON r.id = m.semantic_model_revision_id
           JOIN app.semantic_models sm ON sm.id = r.semantic_model_id
           JOIN app.datasets d ON d.id = sm.dataset_id
           WHERE m.id = $1 AND d.workspace_id = $2`,
          [input.metricId, input.workspaceId],
        );
        if (!persisted.rowCount) return { outcome: "REMOVED" };
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("METRIC_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected) throw new Error("METRIC_WRITE_FAILED");
    throw new Error("METRIC_OUTCOME_UNKNOWN");
  }
}

export async function listMetrics(
  pool: Pool,
  input: MetricScope,
): Promise<ListMetricsResult> {
  validateListMetricsInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = await loadRevision(client, input, false);
    if (!revision) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    const fields = await loadFieldTypes(client, revision.id);
    const rows = (
      await client.query<MetricRow>(
        `SELECT * FROM app.metrics
         WHERE semantic_model_revision_id = $1 ORDER BY name`,
        [revision.id],
      )
    ).rows;
    const metrics = rows.map((row) => snapshot(row, fields));
    await client.query("COMMIT");
    return { outcome: "FOUND", revisionStatus: revision.status, metrics };
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Unknown read transaction state. */
    }
    throw new Error("METRIC_READ_FAILED");
  } finally {
    client.release();
  }
}
