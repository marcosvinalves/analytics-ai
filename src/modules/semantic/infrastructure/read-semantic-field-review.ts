import type { Pool, PoolClient } from "pg";
import {
  proposeSemanticType,
  type SemanticFieldReview,
  type SemanticFieldReviewColumn,
  type SemanticFieldReviewResult,
} from "../domain/semantic-field-review.ts";
import {
  classifyTypeCompatibility,
  semanticTypeFromStorage,
} from "../domain/semantic-field.ts";

type ScopeRow = {
  dataset_id: string;
  dataset_name: string;
  revision_id: string | null;
  revision_number: number | null;
  revision_status: string | null;
  version_id: string | null;
  version_number: number | null;
  version_status: string | null;
  version_dataset_id: string | null;
};

type ColumnRow = {
  dataset_column_id: string;
  physical_name: string;
  inferred_type: string;
  ordinal_position: number;
  nullable: boolean | null;
  null_count: string | null;
  field_id: string | null;
  field_key: string | null;
  field_name: string | null;
  field_label: string | null;
  field_description: string | null;
  semantic_type: string | null;
  decimal_precision: number | null;
  decimal_scale: number | null;
  referenced_by_metric: boolean;
};

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const brokenMessage = "A revisão semântica não pôde ser lida com segurança.";

function validInput(input: { workspaceId: string; datasetId: string }) {
  return (
    input &&
    typeof input === "object" &&
    Object.keys(input).sort().join(",") === "datasetId,workspaceId" &&
    UUID.test(input.workspaceId) &&
    UUID.test(input.datasetId)
  );
}

async function scope(
  client: PoolClient,
  input: { workspaceId: string; datasetId: string },
) {
  return (
    await client.query<ScopeRow>(
      `/* semantic-field-review:scope */
       SELECT d.id AS dataset_id,d.name AS dataset_name,
         r.id AS revision_id,r.revision_number,r.status AS revision_status,
         v.id AS version_id,v.version_number,v.status AS version_status,
         v.dataset_id AS version_dataset_id
       FROM app.datasets d
       LEFT JOIN app.semantic_models m ON m.dataset_id=d.id
       LEFT JOIN app.semantic_model_revisions r
         ON r.semantic_model_id=m.id AND r.status='DRAFT'
       LEFT JOIN app.dataset_versions v ON v.id=r.dataset_version_id
       WHERE d.id=$1 AND d.workspace_id=$2`,
      [input.datasetId, input.workspaceId],
    )
  ).rows[0];
}

async function columns(
  client: PoolClient,
  revisionId: string,
  versionId: string,
) {
  return (
    await client.query<ColumnRow>(
      `/* semantic-field-review:columns */
       SELECT c.id AS dataset_column_id,c.physical_name,c.inferred_type,
         c.ordinal_position,c.nullable,c.null_count::text,
         f.id AS field_id,f.field_key,f.name AS field_name,f.label AS field_label,
         f.description AS field_description,f.semantic_type,
         f.decimal_precision,f.decimal_scale,
         CASE WHEN f.id IS NULL THEN false ELSE EXISTS (
           SELECT 1 FROM app.metric_field_references x
           WHERE x.semantic_model_revision_id=$1 AND x.field_key=f.field_key
         ) END AS referenced_by_metric
       FROM app.dataset_columns c
       LEFT JOIN app.semantic_fields f
         ON f.dataset_column_id=c.id
        AND f.dataset_version_id=c.dataset_version_id
        AND f.semantic_model_revision_id=$1
       WHERE c.dataset_version_id=$2
       ORDER BY c.ordinal_position,c.id`,
      [revisionId, versionId],
    )
  ).rows;
}

function column(row: ColumnRow): SemanticFieldReviewColumn {
  const proposedSemanticType = proposeSemanticType(row.inferred_type);
  if (row.field_id === null) {
    if (
      row.field_key !== null ||
      row.field_name !== null ||
      row.field_label !== null ||
      row.semantic_type !== null
    )
      throw new Error("SEMANTIC_FIELD_REVIEW_PARTIAL_FIELD");
    return {
      datasetColumnId: row.dataset_column_id,
      physicalName: row.physical_name,
      physicalType: row.inferred_type,
      ordinalPosition: row.ordinal_position,
      nullable: row.nullable,
      nullCount: row.null_count,
      proposedSemanticType,
      field: null,
    };
  }
  if (
    row.field_key === null ||
    row.field_name === null ||
    row.field_label === null ||
    row.semantic_type === null
  )
    throw new Error("SEMANTIC_FIELD_REVIEW_PARTIAL_FIELD");
  const semanticType = semanticTypeFromStorage(
    row.semantic_type,
    row.decimal_precision,
    row.decimal_scale,
  );
  const compatibility = classifyTypeCompatibility(
    row.inferred_type,
    semanticType,
  );
  if (compatibility.compatibility === "INVALID")
    throw new Error("SEMANTIC_FIELD_REVIEW_INVALID_MAPPING");
  return {
    datasetColumnId: row.dataset_column_id,
    physicalName: row.physical_name,
    physicalType: row.inferred_type,
    ordinalPosition: row.ordinal_position,
    nullable: row.nullable,
    nullCount: row.null_count,
    proposedSemanticType,
    field: {
      id: row.field_id,
      fieldKey: row.field_key,
      name: row.field_name,
      label: row.field_label,
      description: row.field_description,
      semanticType,
      compatibility,
      referencedByMetric: row.referenced_by_metric,
    },
  };
}

export async function readSemanticFieldReview(
  pool: Pool,
  input: { workspaceId: string; datasetId: string },
): Promise<SemanticFieldReviewResult> {
  if (!validInput(input))
    throw new TypeError("Argumentos inválidos para revisão de campos.");
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = await scope(client, input);
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    if (row.revision_id === null) {
      await client.query("COMMIT");
      return { outcome: "NO_DRAFT" };
    }
    if (
      row.revision_number === null ||
      row.revision_status !== "DRAFT" ||
      row.version_id === null ||
      row.version_number === null ||
      row.version_status !== "READY" ||
      row.version_dataset_id !== row.dataset_id
    ) {
      await client.query("COMMIT");
      return { outcome: "BROKEN", message: brokenMessage };
    }
    const mappedColumns = (
      await columns(client, row.revision_id, row.version_id)
    ).map(column);
    if (!mappedColumns.length) {
      await client.query("COMMIT");
      return { outcome: "BROKEN", message: brokenMessage };
    }
    const review: SemanticFieldReview = {
      dataset: { id: row.dataset_id, name: row.dataset_name },
      revision: {
        id: row.revision_id,
        revisionNumber: row.revision_number,
        status: "DRAFT",
      },
      datasetVersion: {
        id: row.version_id,
        versionNumber: row.version_number,
        status: "READY",
      },
      columns: mappedColumns,
    };
    await client.query("COMMIT");
    return { outcome: "EDITABLE", review };
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* The read remains unavailable. */
    }
    return { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}
