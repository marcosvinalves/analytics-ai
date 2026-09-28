import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  classifyTypeCompatibility,
  semanticTypeFromStorage,
  validateCreateSemanticFieldInput,
  validateListSemanticFieldsInput,
  validateRemoveSemanticFieldInput,
  validateUpdateSemanticFieldInput,
  type CompatibilityResult,
  type CreateSemanticFieldInput,
  type CreateSemanticFieldResult,
  type ListSemanticFieldsResult,
  type RemoveSemanticFieldInput,
  type RemoveSemanticFieldResult,
  type SemanticFieldConflict,
  type SemanticFieldScope,
  type SemanticFieldSnapshot,
  type SemanticType,
  type UpdateSemanticFieldInput,
  type UpdateSemanticFieldResult,
} from "../domain/semantic-field.ts";
import { validateMetricExpression } from "../domain/metric-expression.ts";
import type { SemanticRevisionStatus } from "../domain/semantic-model.ts";

type RevisionRow = {
  id: string;
  dataset_version_id: string;
  status: SemanticRevisionStatus;
};

type ColumnRow = {
  id: string;
  dataset_version_id: string;
  physical_name: string;
  inferred_type: string;
  ordinal_position: number;
};

type FieldRow = {
  id: string;
  field_key: string;
  semantic_model_revision_id: string;
  dataset_version_id: string;
  dataset_column_id: string;
  name: string;
  label: string;
  description: string | null;
  semantic_type: string;
  decimal_precision: number | null;
  decimal_scale: number | null;
  created_at: Date;
  updated_at: Date;
  physical_name: string;
  inferred_type: string;
  ordinal_position: number;
};

type ReferencingMetricRow = {
  metric_key: string;
  expression: unknown;
};

const fieldColumns = `f.id, f.field_key, f.semantic_model_revision_id,
  f.dataset_version_id, f.dataset_column_id, f.name, f.label, f.description,
  f.semantic_type, f.decimal_precision, f.decimal_scale, f.created_at, f.updated_at,
  c.physical_name, c.inferred_type, c.ordinal_position`;

function snapshot(row: FieldRow): SemanticFieldSnapshot {
  const semanticType = semanticTypeFromStorage(
    row.semantic_type,
    row.decimal_precision,
    row.decimal_scale,
  );
  return {
    id: row.id,
    fieldKey: row.field_key,
    semanticModelRevisionId: row.semantic_model_revision_id,
    datasetVersionId: row.dataset_version_id,
    datasetColumnId: row.dataset_column_id,
    physicalName: row.physical_name,
    physicalType: row.inferred_type,
    ordinalPosition: row.ordinal_position,
    name: row.name,
    label: row.label,
    description: row.description,
    semanticType,
    compatibility: classifyTypeCompatibility(row.inferred_type, semanticType),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageType(type: SemanticType): {
  kind: string;
  precision: number | null;
  scale: number | null;
} {
  return type.kind === "DECIMAL"
    ? { kind: type.kind, precision: type.precision, scale: type.scale }
    : { kind: type.kind, precision: null, scale: null };
}

async function loadRevision(
  client: PoolClient,
  scope: SemanticFieldScope,
): Promise<RevisionRow | undefined> {
  return (
    await client.query<RevisionRow>(
      `SELECT r.id, r.dataset_version_id, r.status
      FROM app.semantic_model_revisions r
      JOIN app.semantic_models m ON m.id = r.semantic_model_id
      JOIN app.datasets d ON d.id = m.dataset_id
      JOIN app.dataset_versions v
        ON v.id = r.dataset_version_id AND v.dataset_id = d.id
      WHERE r.id = $1 AND d.workspace_id = $2
      FOR UPDATE OF r`,
      [scope.semanticModelRevisionId, scope.workspaceId],
    )
  ).rows[0];
}

async function loadColumn(
  client: PoolClient,
  datasetVersionId: string,
  datasetColumnId: string,
): Promise<ColumnRow | undefined> {
  return (
    await client.query<ColumnRow>(
      `SELECT id, dataset_version_id, physical_name, inferred_type, ordinal_position
      FROM app.dataset_columns
      WHERE id = $1 AND dataset_version_id = $2
      FOR SHARE`,
      [datasetColumnId, datasetVersionId],
    )
  ).rows[0];
}

async function loadField(
  client: PoolClient,
  revisionId: string,
  fieldId: string,
): Promise<FieldRow | undefined> {
  return (
    await client.query<FieldRow>(
      `SELECT ${fieldColumns}
      FROM app.semantic_fields f
      JOIN app.dataset_columns c
        ON c.id = f.dataset_column_id AND c.dataset_version_id = f.dataset_version_id
      WHERE f.id = $1 AND f.semantic_model_revision_id = $2
      FOR UPDATE OF f`,
      [fieldId, revisionId],
    )
  ).rows[0];
}

async function invalidMetricAfterTypeChange(
  client: PoolClient,
  revisionId: string,
  fieldKey: string,
  semanticType: SemanticType,
) {
  const fieldRows = (
    await client.query<{
      field_key: string;
      semantic_type: string;
      decimal_precision: number | null;
      decimal_scale: number | null;
    }>(
      `SELECT field_key, semantic_type, decimal_precision, decimal_scale
       FROM app.semantic_fields WHERE semantic_model_revision_id = $1`,
      [revisionId],
    )
  ).rows;
  const fields = new Map(
    fieldRows.map((row) => [
      row.field_key,
      semanticTypeFromStorage(
        row.semantic_type,
        row.decimal_precision,
        row.decimal_scale,
      ),
    ]),
  );
  fields.set(fieldKey, semanticType);
  const metrics = (
    await client.query<ReferencingMetricRow>(
      `SELECT m.metric_key, m.expression
       FROM app.metric_field_references r
       JOIN app.metrics m ON m.id = r.metric_id
       WHERE r.semantic_model_revision_id = $1 AND r.field_key = $2
       ORDER BY m.metric_key`,
      [revisionId, fieldKey],
    )
  ).rows;
  for (const metric of metrics) {
    const validated = validateMetricExpression(metric.expression, fields);
    if (!validated.valid)
      return { metricKey: metric.metric_key, error: validated.error };
  }
  return undefined;
}

async function finish<T>(client: PoolClient, result: T): Promise<T> {
  await client.query("ROLLBACK");
  client.release();
  return result;
}

function editabilityFailure(status: SemanticRevisionStatus) {
  if (status === "DRAFT") return undefined;
  return { outcome: "REVISION_NOT_EDITABLE" as const, status };
}

function compatibilityFailure(
  compatibility: CompatibilityResult,
  accepted: boolean | undefined,
) {
  if (compatibility.compatibility === "INVALID")
    return { outcome: "INCOMPATIBLE_TYPE" as const, compatibility };
  if (compatibility.compatibility === "EXPLICIT" && accepted !== true)
    return {
      outcome: "EXPLICIT_CONVERSION_REQUIRED" as const,
      compatibility,
    };
  return undefined;
}

function conflictFromConstraint(
  error: unknown,
): SemanticFieldConflict | undefined {
  if (!error || typeof error !== "object" || !("constraint" in error))
    return undefined;
  switch ((error as { constraint?: unknown }).constraint) {
    case "semantic_fields_key_unique":
      return "FIELD_KEY_ALREADY_EXISTS";
    case "semantic_fields_name_unique":
      return "NAME_ALREADY_EXISTS";
    case "semantic_fields_column_unique":
      return "DATASET_COLUMN_ALREADY_MAPPED";
    default:
      return undefined;
  }
}

async function findConflict(
  client: PoolClient,
  revisionId: string,
  fieldKey: string,
  name: string,
  columnId: string,
  excludedId?: string,
): Promise<SemanticFieldConflict | undefined> {
  const row = (
    await client.query<{
      field_key_conflict: boolean;
      name_conflict: boolean;
      column_conflict: boolean;
    }>(
      `SELECT
        bool_or(field_key = $2) AS field_key_conflict,
        bool_or(name = $3) AS name_conflict,
        bool_or(dataset_column_id = $4) AS column_conflict
      FROM app.semantic_fields
      WHERE semantic_model_revision_id = $1 AND ($5::uuid IS NULL OR id <> $5)`,
      [revisionId, fieldKey, name, columnId, excludedId ?? null],
    )
  ).rows[0];
  if (row.field_key_conflict) return "FIELD_KEY_ALREADY_EXISTS";
  if (row.name_conflict) return "NAME_ALREADY_EXISTS";
  if (row.column_conflict) return "DATASET_COLUMN_ALREADY_MAPPED";
  return undefined;
}

async function readScopedField(
  pool: Pool,
  workspaceId: string,
  fieldId: string,
): Promise<FieldRow | undefined> {
  return (
    await pool.query<FieldRow>(
      `SELECT ${fieldColumns}
      FROM app.semantic_fields f
      JOIN app.dataset_columns c
        ON c.id = f.dataset_column_id AND c.dataset_version_id = f.dataset_version_id
      JOIN app.semantic_model_revisions r ON r.id = f.semantic_model_revision_id
      JOIN app.semantic_models m ON m.id = r.semantic_model_id
      JOIN app.datasets d ON d.id = m.dataset_id
      WHERE f.id = $1 AND d.workspace_id = $2`,
      [fieldId, workspaceId],
    )
  ).rows[0];
}

function sameSemanticType(left: SemanticType, right: SemanticType): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "DECIMAL" ||
      (right.kind === "DECIMAL" &&
        left.precision === right.precision &&
        left.scale === right.scale))
  );
}

function sameDesiredField(
  field: SemanticFieldSnapshot,
  desired: {
    datasetColumnId: string;
    name: string;
    label: string;
    description: string | null;
    semanticType: SemanticType;
  },
): boolean {
  return (
    field.datasetColumnId === desired.datasetColumnId &&
    field.name === desired.name &&
    field.label === desired.label &&
    field.description === desired.description &&
    sameSemanticType(field.semanticType, desired.semanticType)
  );
}

/** Creates one field in a scoped DRAFT. This is metadata only, not authorization or execution. */
export async function createSemanticField(
  pool: Pool,
  input: CreateSemanticFieldInput,
): Promise<CreateSemanticFieldResult> {
  validateCreateSemanticFieldInput(input);
  const id = randomUUID();
  const fieldKey = randomUUID();
  const description = input.description ?? null;
  const storedType = storageType(input.semanticType);
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const notEditable = editabilityFailure(revision.status);
    if (notEditable) return await finish(client, notEditable);
    const column = await loadColumn(
      client,
      revision.dataset_version_id,
      input.datasetColumnId,
    );
    if (!column) return await finish(client, { outcome: "NOT_FOUND" });
    const compatibility = classifyTypeCompatibility(
      column.inferred_type,
      input.semanticType,
    );
    const incompatible = compatibilityFailure(
      compatibility,
      input.acceptExplicitConversion,
    );
    if (incompatible) return await finish(client, incompatible);
    const conflict = await findConflict(
      client,
      revision.id,
      fieldKey,
      input.name,
      column.id,
    );
    if (conflict)
      return await finish(client, { outcome: "CONFLICT", reason: conflict });
    let inserted: FieldRow;
    try {
      inserted = (
        await client.query<FieldRow>(
          `WITH inserted AS (
            INSERT INTO app.semantic_fields
              (id, field_key, semantic_model_revision_id, dataset_version_id,
               dataset_column_id, name, label, description, semantic_type,
               decimal_precision, decimal_scale)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *
          )
          SELECT i.*, c.physical_name, c.inferred_type, c.ordinal_position
          FROM inserted i JOIN app.dataset_columns c
            ON c.id = i.dataset_column_id AND c.dataset_version_id = i.dataset_version_id`,
          [
            id,
            fieldKey,
            revision.id,
            revision.dataset_version_id,
            column.id,
            input.name,
            input.label,
            description,
            storedType.kind,
            storedType.precision,
            storedType.scale,
          ],
        )
      ).rows[0];
    } catch (error) {
      const reason = conflictFromConstraint(error);
      if (reason) return await finish(client, { outcome: "CONFLICT", reason });
      throw error;
    }
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return { outcome: "CREATED", field: snapshot(inserted) };
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
        const persisted = await readScopedField(pool, input.workspaceId, id);
        if (persisted)
          return { outcome: "CREATED", field: snapshot(persisted) };
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected)
      throw new Error("SEMANTIC_FIELD_WRITE_FAILED");
    throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
  }
}

/** Updates mutable DRAFT content while preserving id and field_key. */
export async function updateSemanticField(
  pool: Pool,
  input: UpdateSemanticFieldInput,
): Promise<UpdateSemanticFieldResult> {
  validateUpdateSemanticFieldInput(input);
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  let desired:
    | {
        datasetColumnId: string;
        name: string;
        label: string;
        description: string | null;
        semanticType: SemanticType;
      }
    | undefined;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const notEditable = editabilityFailure(revision.status);
    if (notEditable) return await finish(client, notEditable);
    const currentRow = await loadField(
      client,
      revision.id,
      input.semanticFieldId,
    );
    if (!currentRow) return await finish(client, { outcome: "NOT_FOUND" });
    const current = snapshot(currentRow);
    const targetColumnId =
      input.changes.datasetColumnId ?? current.datasetColumnId;
    const column = await loadColumn(
      client,
      revision.dataset_version_id,
      targetColumnId,
    );
    if (!column) return await finish(client, { outcome: "NOT_FOUND" });
    desired = {
      datasetColumnId: column.id,
      name: input.changes.name ?? current.name,
      label: input.changes.label ?? current.label,
      description:
        "description" in input.changes
          ? (input.changes.description ?? null)
          : current.description,
      semanticType: input.changes.semanticType ?? current.semanticType,
    };
    const compatibility = classifyTypeCompatibility(
      column.inferred_type,
      desired.semanticType,
    );
    const mappingChanged =
      desired.datasetColumnId !== current.datasetColumnId ||
      !sameSemanticType(desired.semanticType, current.semanticType);
    const incompatible = compatibilityFailure(
      compatibility,
      mappingChanged ? input.changes.acceptExplicitConversion : true,
    );
    if (incompatible) return await finish(client, incompatible);
    if (!sameSemanticType(desired.semanticType, current.semanticType)) {
      const invalidMetric = await invalidMetricAfterTypeChange(
        client,
        revision.id,
        current.fieldKey,
        desired.semanticType,
      );
      if (invalidMetric)
        return await finish(client, {
          outcome: "FIELD_CHANGE_INVALIDATES_METRIC",
          ...invalidMetric,
        });
    }
    const conflict = await findConflict(
      client,
      revision.id,
      current.fieldKey,
      desired.name,
      desired.datasetColumnId,
      current.id,
    );
    if (conflict)
      return await finish(client, { outcome: "CONFLICT", reason: conflict });
    if (sameDesiredField(current, desired))
      return await finish(client, { outcome: "UNCHANGED", field: current });
    const storedType = storageType(desired.semanticType);
    let updated: FieldRow;
    try {
      updated = (
        await client.query<FieldRow>(
          `WITH updated AS (
            UPDATE app.semantic_fields
            SET dataset_column_id = $3, name = $4, label = $5, description = $6,
                semantic_type = $7, decimal_precision = $8, decimal_scale = $9
            WHERE id = $1 AND semantic_model_revision_id = $2
            RETURNING *
          )
          SELECT u.*, c.physical_name, c.inferred_type, c.ordinal_position
          FROM updated u JOIN app.dataset_columns c
            ON c.id = u.dataset_column_id AND c.dataset_version_id = u.dataset_version_id`,
          [
            current.id,
            revision.id,
            desired.datasetColumnId,
            desired.name,
            desired.label,
            desired.description,
            storedType.kind,
            storedType.precision,
            storedType.scale,
          ],
        )
      ).rows[0];
    } catch (error) {
      const reason = conflictFromConstraint(error);
      if (reason) return await finish(client, { outcome: "CONFLICT", reason });
      throw error;
    }
    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return { outcome: "UPDATED", field: snapshot(updated) };
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
        const persisted = await readScopedField(
          pool,
          input.workspaceId,
          input.semanticFieldId,
        );
        if (persisted) {
          const field = snapshot(persisted);
          if (sameDesiredField(field, desired))
            return { outcome: "UPDATED", field };
        }
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected)
      throw new Error("SEMANTIC_FIELD_WRITE_FAILED");
    throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
  }
}

/** Removes unpublished DRAFT content. Published-content protection is completed in T-013. */
export async function removeSemanticField(
  pool: Pool,
  input: RemoveSemanticFieldInput,
): Promise<RemoveSemanticFieldResult> {
  validateRemoveSemanticFieldInput(input);
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const revision = await loadRevision(client, input);
    if (!revision) return await finish(client, { outcome: "NOT_FOUND" });
    const notEditable = editabilityFailure(revision.status);
    if (notEditable) return await finish(client, notEditable);
    const field = await loadField(client, revision.id, input.semanticFieldId);
    if (!field) return await finish(client, { outcome: "NOT_FOUND" });
    const metric = (
      await client.query<{ metric_key: string }>(
        `SELECT m.metric_key
         FROM app.metric_field_references r
         JOIN app.metrics m ON m.id = r.metric_id
         WHERE r.semantic_model_revision_id = $1 AND r.field_key = $2
         ORDER BY m.metric_key LIMIT 1`,
        [revision.id, field.field_key],
      )
    ).rows[0];
    if (metric)
      return await finish(client, {
        outcome: "FIELD_IN_USE",
        metricKey: metric.metric_key,
      });
    const deleted = await client.query(
      `DELETE FROM app.semantic_fields
      WHERE id = $1 AND semantic_model_revision_id = $2`,
      [input.semanticFieldId, revision.id],
    );
    if (!deleted.rowCount)
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
        const revision = await pool.query(
          `SELECT 1 FROM app.semantic_model_revisions r
          JOIN app.semantic_models m ON m.id = r.semantic_model_id
          JOIN app.datasets d ON d.id = m.dataset_id
          WHERE r.id = $1 AND d.workspace_id = $2`,
          [input.semanticModelRevisionId, input.workspaceId],
        );
        const field = await readScopedField(
          pool,
          input.workspaceId,
          input.semanticFieldId,
        );
        if (revision.rowCount === 1 && !field) return { outcome: "REMOVED" };
      } catch {
        /* Do not infer rollback or expose database details. */
      }
      throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
    }
    if (rollbackConfirmed || !connected)
      throw new Error("SEMANTIC_FIELD_WRITE_FAILED");
    throw new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN");
  }
}

/** Minimal internal read for T-012; no endpoint or inspection UI. */
export async function listSemanticFields(
  pool: Pool,
  input: SemanticFieldScope,
): Promise<ListSemanticFieldsResult> {
  validateListSemanticFieldsInput(input);
  try {
    const result = await pool.query<
      FieldRow & {
        revision_status: SemanticRevisionStatus;
        revision_exists: boolean;
      }
    >(
      `SELECT r.status AS revision_status, true AS revision_exists,
        f.id, f.field_key, f.semantic_model_revision_id, f.dataset_version_id,
        f.dataset_column_id, f.name, f.label, f.description, f.semantic_type,
        f.decimal_precision, f.decimal_scale, f.created_at, f.updated_at,
        c.physical_name, c.inferred_type, c.ordinal_position
      FROM app.semantic_model_revisions r
      JOIN app.semantic_models m ON m.id = r.semantic_model_id
      JOIN app.datasets d ON d.id = m.dataset_id
      JOIN app.dataset_versions v
        ON v.id = r.dataset_version_id AND v.dataset_id = d.id
      LEFT JOIN app.semantic_fields f ON f.semantic_model_revision_id = r.id
      LEFT JOIN app.dataset_columns c
        ON c.id = f.dataset_column_id AND c.dataset_version_id = f.dataset_version_id
      WHERE r.id = $1 AND d.workspace_id = $2
      ORDER BY c.ordinal_position NULLS LAST`,
      [input.semanticModelRevisionId, input.workspaceId],
    );
    if (!result.rows[0]) return { outcome: "NOT_FOUND" };
    return {
      outcome: "FOUND",
      revisionStatus: result.rows[0].revision_status,
      fields: result.rows.filter((row) => row.id !== null).map(snapshot),
    };
  } catch {
    throw new Error("SEMANTIC_FIELD_READ_FAILED");
  }
}
