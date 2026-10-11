import type { Pool, PoolClient } from "pg";
import {
  classifyGovernedMetricExpression,
  type GovernedMetricClassification,
} from "../domain/governed-metric-template.ts";
import { validateMetricExpression } from "../domain/metric-expression.ts";
import {
  type SemanticMetricReview,
  type SemanticMetricReviewField,
  type SemanticMetricReviewMetric,
  type SemanticMetricReviewResult,
} from "../domain/semantic-metric-review.ts";
import { semanticTypeFromStorage } from "../domain/semantic-field.ts";

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

type FieldRow = {
  dataset_column_id: string;
  field_key: string;
  name: string;
  label: string;
  semantic_type: string;
  decimal_precision: number | null;
  decimal_scale: number | null;
  ordinal_position: number;
};

type MetricRow = {
  id: string;
  metric_key: string;
  name: string;
  label: string;
  description: string | null;
  expression: unknown;
};

type ReferenceRow = { metric_id: string; field_key: string };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const brokenMessage =
  "As métricas deste draft não puderam ser lidas com segurança.";

function validInput(input: { workspaceId: string; datasetId: string }) {
  return (
    input &&
    typeof input === "object" &&
    Object.keys(input).sort().join(",") === "datasetId,workspaceId" &&
    UUID.test(input.workspaceId) &&
    UUID.test(input.datasetId)
  );
}

async function readScope(
  client: PoolClient,
  input: { workspaceId: string; datasetId: string },
) {
  return (
    await client.query<ScopeRow>(
      `/* semantic-metric-review:scope */
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

async function readFields(
  client: PoolClient,
  revisionId: string,
  versionId: string,
) {
  return (
    await client.query<FieldRow>(
      `/* semantic-metric-review:fields */
       SELECT f.dataset_column_id,f.field_key,f.name,f.label,f.semantic_type,
         f.decimal_precision,f.decimal_scale,c.ordinal_position
       FROM app.semantic_fields f
       JOIN app.dataset_columns c
         ON c.id=f.dataset_column_id AND c.dataset_version_id=f.dataset_version_id
       WHERE f.semantic_model_revision_id=$1 AND f.dataset_version_id=$2
       ORDER BY c.ordinal_position,f.field_key`,
      [revisionId, versionId],
    )
  ).rows;
}

async function readMetrics(client: PoolClient, revisionId: string) {
  return (
    await client.query<MetricRow>(
      `/* semantic-metric-review:metrics */
       SELECT id,metric_key,name,label,description,expression
       FROM app.metrics
       WHERE semantic_model_revision_id=$1
       ORDER BY name,metric_key`,
      [revisionId],
    )
  ).rows;
}

async function readReferences(client: PoolClient, revisionId: string) {
  return (
    await client.query<ReferenceRow>(
      `/* semantic-metric-review:references */
       SELECT metric_id,field_key
       FROM app.metric_field_references
       WHERE semantic_model_revision_id=$1
       ORDER BY metric_id,field_key`,
      [revisionId],
    )
  ).rows;
}

function sameKeys(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assemble(
  scope: ScopeRow,
  fieldRows: FieldRow[],
  metricRows: MetricRow[],
  referenceRows: ReferenceRow[],
): SemanticMetricReview {
  const fields: SemanticMetricReviewField[] = fieldRows.map((row) => ({
    datasetColumnId: row.dataset_column_id,
    fieldKey: row.field_key,
    name: row.name,
    label: row.label,
    semanticType: semanticTypeFromStorage(
      row.semantic_type,
      row.decimal_precision,
      row.decimal_scale,
    ),
    ordinalPosition: row.ordinal_position,
  }));
  const fieldTypes = new Map(
    fields.map((field) => [field.fieldKey, field.semanticType]),
  );
  const fieldsByKey = new Map(fields.map((field) => [field.fieldKey, field]));
  const references = new Map<string, string[]>();
  for (const row of referenceRows) {
    const current = references.get(row.metric_id) ?? [];
    current.push(row.field_key);
    references.set(row.metric_id, current);
  }
  const metrics: SemanticMetricReviewMetric[] = metricRows.map((row) => {
    const validated = validateMetricExpression(row.expression, fieldTypes);
    if (!validated.valid) throw new Error("INVALID_METRIC_EXPRESSION");
    const persisted = references.get(row.id) ?? [];
    if (!sameKeys(validated.value.fieldKeys, persisted))
      throw new Error("INVALID_METRIC_REFERENCES");
    const dependencies = validated.value.fieldKeys.map((key) => {
      const field = fieldsByKey.get(key);
      if (!field) throw new Error("UNKNOWN_METRIC_FIELD");
      return field;
    });
    const classification: GovernedMetricClassification =
      classifyGovernedMetricExpression(validated.value.expression);
    return {
      metricKey: row.metric_key,
      name: row.name,
      label: row.label,
      description: row.description,
      resultType: validated.value.resultType,
      dependencies,
      classification,
    };
  });
  return {
    dataset: { id: scope.dataset_id, name: scope.dataset_name },
    revision: {
      id: scope.revision_id!,
      revisionNumber: scope.revision_number!,
      status: "DRAFT",
    },
    datasetVersion: {
      id: scope.version_id!,
      versionNumber: scope.version_number!,
      status: "READY",
    },
    fields,
    metrics,
  };
}

export async function readSemanticMetricReview(
  pool: Pool,
  input: { workspaceId: string; datasetId: string },
): Promise<SemanticMetricReviewResult> {
  if (!validInput(input))
    throw new TypeError("Argumentos inválidos para revisão de métricas.");
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const scope = await readScope(client, input);
    if (!scope) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    if (scope.revision_id === null) {
      await client.query("COMMIT");
      return { outcome: "NO_DRAFT" };
    }
    if (
      scope.revision_number === null ||
      scope.revision_status !== "DRAFT" ||
      scope.version_id === null ||
      scope.version_number === null ||
      scope.version_status !== "READY" ||
      scope.version_dataset_id !== scope.dataset_id
    ) {
      await client.query("COMMIT");
      return { outcome: "BROKEN", message: brokenMessage };
    }
    const fields = await readFields(
      client,
      scope.revision_id,
      scope.version_id,
    );
    const metrics = await readMetrics(client, scope.revision_id);
    const references = await readReferences(client, scope.revision_id);
    let review: SemanticMetricReview;
    try {
      review = assemble(scope, fields, metrics, references);
    } catch {
      await client.query("COMMIT");
      return { outcome: "BROKEN", message: brokenMessage };
    }
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
