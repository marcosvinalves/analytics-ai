import type { Pool, PoolClient } from "pg";
import {
  semanticTypeFromStorage,
  type SemanticType,
} from "../domain/semantic-field.ts";
import {
  assembleSemanticModelInspection,
  validateInspectPublishedSemanticModelInput,
  validateInspectSemanticModelRevisionInput,
  type InspectPublishedSemanticModelInput,
  type InspectPublishedSemanticModelResult,
  type InspectSemanticModelRevisionInput,
  type InspectSemanticModelRevisionResult,
  type SemanticInspectionCandidate,
  type SemanticInspectionFieldCandidate,
  type SemanticInspectionMetricCandidate,
} from "../domain/semantic-inspection.ts";
import type {
  DatasetVersionStatus,
  SemanticRevisionStatus,
} from "../domain/semantic-model.ts";

type InspectionRow = {
  model_id: string;
  model_name: string;
  model_dataset_id: string;
  dataset_id: string;
  dataset_name: string;
  revision_id: string;
  revision_number: number;
  revision_status: SemanticRevisionStatus;
  revision_label: string;
  revision_description: string | null;
  revision_created_at: Date;
  revision_published_at: Date | null;
  version_id: string;
  version_number: number;
  version_status: DatasetVersionStatus;
  version_dataset_id: string;
};

type PublishedLookupRow = Omit<
  InspectionRow,
  | "revision_id"
  | "revision_number"
  | "revision_status"
  | "revision_label"
  | "revision_description"
  | "revision_created_at"
  | "revision_published_at"
  | "version_id"
  | "version_number"
  | "version_status"
  | "version_dataset_id"
> & {
  revision_id: string | null;
  revision_number: number | null;
  revision_status: SemanticRevisionStatus | null;
  revision_label: string | null;
  revision_description: string | null;
  revision_created_at: Date | null;
  revision_published_at: Date | null;
  version_id: string | null;
  version_number: number | null;
  version_status: DatasetVersionStatus | null;
  version_dataset_id: string | null;
};

type FieldRow = {
  field_key: string;
  field_dataset_version_id: string;
  name: string;
  label: string;
  description: string | null;
  semantic_type: string;
  decimal_precision: number | null;
  decimal_scale: number | null;
  column_id: string | null;
  column_dataset_version_id: string | null;
  physical_name: string | null;
  physical_type: string | null;
  ordinal_position: number | null;
};

type MetricRow = {
  id: string;
  metric_key: string;
  name: string;
  label: string;
  description: string | null;
  expression: unknown;
};

function storedSemanticType(row: FieldRow): SemanticType | null {
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

function completePublishedRow(row: PublishedLookupRow): InspectionRow | null {
  if (
    row.revision_id === null ||
    row.revision_number === null ||
    row.revision_status === null ||
    row.revision_label === null ||
    row.revision_created_at === null ||
    row.version_id === null ||
    row.version_number === null ||
    row.version_status === null ||
    row.version_dataset_id === null
  )
    return null;
  return {
    ...row,
    revision_id: row.revision_id,
    revision_number: row.revision_number,
    revision_status: row.revision_status,
    revision_label: row.revision_label,
    revision_description: row.revision_description,
    revision_created_at: row.revision_created_at,
    revision_published_at: row.revision_published_at,
    version_id: row.version_id,
    version_number: row.version_number,
    version_status: row.version_status,
    version_dataset_id: row.version_dataset_id,
  };
}

async function loadCandidate(
  client: PoolClient,
  row: InspectionRow,
): Promise<SemanticInspectionCandidate> {
  const fieldRows = (
    await client.query<FieldRow>(
      `SELECT f.field_key, f.dataset_version_id AS field_dataset_version_id,
        f.name, f.label, f.description, f.semantic_type,
        f.decimal_precision, f.decimal_scale, c.id AS column_id,
        c.dataset_version_id AS column_dataset_version_id,
        c.physical_name, c.inferred_type AS physical_type, c.ordinal_position
       FROM app.semantic_fields f
       LEFT JOIN app.dataset_columns c
         ON c.id = f.dataset_column_id
        AND c.dataset_version_id = f.dataset_version_id
       WHERE f.semantic_model_revision_id = $1`,
      [row.revision_id],
    )
  ).rows;
  const metricRows = (
    await client.query<MetricRow>(
      `SELECT id, metric_key, name, label, description, expression
       FROM app.metrics WHERE semantic_model_revision_id = $1`,
      [row.revision_id],
    )
  ).rows;
  const referenceRows = (
    await client.query<{ metric_id: string; field_key: string }>(
      `SELECT metric_id, field_key FROM app.metric_field_references
       WHERE semantic_model_revision_id = $1`,
      [row.revision_id],
    )
  ).rows;
  const references = new Map<string, string[]>();
  for (const reference of referenceRows)
    references.set(reference.metric_id, [
      ...(references.get(reference.metric_id) ?? []),
      reference.field_key,
    ]);
  const fields: SemanticInspectionFieldCandidate[] = fieldRows.map((field) => ({
    fieldKey: field.field_key,
    name: field.name,
    label: field.label,
    description: field.description,
    semanticType: storedSemanticType(field),
    physicalName: field.physical_name,
    physicalType: field.physical_type,
    ordinalPosition: field.ordinal_position,
    lineageValid:
      field.column_id !== null &&
      field.physical_name !== null &&
      field.physical_type !== null &&
      field.ordinal_position !== null &&
      field.field_dataset_version_id === row.version_id &&
      field.column_dataset_version_id === row.version_id,
  }));
  const metrics: SemanticInspectionMetricCandidate[] = metricRows.map(
    (metric) => ({
      metricKey: metric.metric_key,
      name: metric.name,
      label: metric.label,
      description: metric.description,
      expression: metric.expression,
      projectedFieldKeys: references.get(metric.id) ?? [],
    }),
  );
  return {
    model: { id: row.model_id, name: row.model_name },
    revision: {
      id: row.revision_id,
      revisionNumber: row.revision_number,
      status: row.revision_status,
      label: row.revision_label,
      description: row.revision_description,
      createdAt: row.revision_created_at,
      publishedAt: row.revision_published_at,
    },
    dataset: { id: row.dataset_id, name: row.dataset_name },
    datasetVersion: {
      id: row.version_id,
      versionNumber: row.version_number,
      status: row.version_status,
    },
    sameDataset:
      row.model_dataset_id === row.dataset_id &&
      row.version_dataset_id === row.dataset_id,
    fields,
    metrics,
  };
}

async function inspectRow(client: PoolClient, row: InspectionRow) {
  const assembled = assembleSemanticModelInspection(
    await loadCandidate(client, row),
  );
  return assembled.consistent
    ? ({ outcome: "SUCCESS", inspection: assembled.inspection } as const)
    : ({
        outcome: "INCONSISTENT_SNAPSHOT",
        semanticModelRevisionId: row.revision_id,
        status: row.revision_status,
        issues: assembled.issues,
      } as const);
}

export async function inspectPublishedSemanticModel(
  pool: Pool,
  input: InspectPublishedSemanticModelInput,
): Promise<InspectPublishedSemanticModelResult> {
  validateInspectPublishedSemanticModelInput(input);
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const lookup = (
      await client.query<PublishedLookupRow>(
        `/* semantic-inspection:published */
         SELECT m.id AS model_id, m.name AS model_name,
           m.dataset_id AS model_dataset_id, d.id AS dataset_id,
           d.name AS dataset_name, r.id AS revision_id,
           r.revision_number, r.status AS revision_status,
           r.label AS revision_label, r.description AS revision_description,
           r.created_at AS revision_created_at,
           r.published_at AS revision_published_at,
           v.id AS version_id, v.version_number,
           v.status AS version_status, v.dataset_id AS version_dataset_id
         FROM app.semantic_models m
         JOIN app.datasets d ON d.id = m.dataset_id
         LEFT JOIN app.semantic_model_revisions r
           ON r.semantic_model_id = m.id AND r.status = 'PUBLISHED'
         LEFT JOIN app.dataset_versions v ON v.id = r.dataset_version_id
         WHERE m.id = $1 AND d.workspace_id = $2`,
        [input.semanticModelId, input.workspaceId],
      )
    ).rows[0];
    if (!lookup) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    const row = completePublishedRow(lookup);
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "NO_PUBLISHED_REVISION" };
    }
    const result = await inspectRow(client, row);
    await client.query("COMMIT");
    return result;
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

export async function inspectSemanticModelRevision(
  pool: Pool,
  input: InspectSemanticModelRevisionInput,
): Promise<InspectSemanticModelRevisionResult> {
  validateInspectSemanticModelRevisionInput(input);
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = (
      await client.query<InspectionRow>(
        `/* semantic-inspection:revision */
         SELECT m.id AS model_id, m.name AS model_name,
           m.dataset_id AS model_dataset_id, d.id AS dataset_id,
           d.name AS dataset_name, r.id AS revision_id,
           r.revision_number, r.status AS revision_status,
           r.label AS revision_label, r.description AS revision_description,
           r.created_at AS revision_created_at,
           r.published_at AS revision_published_at,
           v.id AS version_id, v.version_number,
           v.status AS version_status, v.dataset_id AS version_dataset_id
         FROM app.semantic_model_revisions r
         JOIN app.semantic_models m ON m.id = r.semantic_model_id
         JOIN app.datasets d ON d.id = m.dataset_id
         JOIN app.dataset_versions v ON v.id = r.dataset_version_id
         WHERE r.id = $1 AND d.workspace_id = $2`,
        [input.semanticModelRevisionId, input.workspaceId],
      )
    ).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    const result = await inspectRow(client, row);
    await client.query("COMMIT");
    return result;
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
