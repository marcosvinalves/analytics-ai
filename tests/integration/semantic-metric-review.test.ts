import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { buildGovernedMetricExpression } from "../../src/modules/semantic/domain/governed-metric-template.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import {
  createMetric,
  removeMetric,
  updateMetric,
} from "../../src/modules/semantic/infrastructure/metrics.ts";
import { readSemanticMetricReview } from "../../src/modules/semantic/infrastructure/read-semantic-metric-review.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let otherWorkspaceId: string;
let rawPath: string;
let rawHash: string;
let storageDirectory: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  revisionId: string;
  fields: Record<string, { id: string; key: string }>;
};

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Metric review') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string }>(
    `INSERT INTO app.workspaces(organization_id,name)
     VALUES ($1,'Metric review'),($1,'Other metric review') RETURNING id`,
    [organizationId],
  );
  [workspaceId, otherWorkspaceId] = workspaces.rows.map((row) => row.id);
  storageDirectory = await mkdtemp(path.join(tmpdir(), "analytics-t035-"));
  rawPath = path.join(storageDirectory, "raw.csv");
  await writeFile(rawPath, "quantity,unit_price,category\n2,10.50,A\n");
  rawHash = await sha256(rawPath);
});

afterAll(async () => {
  await pool?.end();
  if (storageDirectory)
    await rm(storageDirectory, { recursive: true, force: true });
  await resetTestDatabase();
}, 30_000);

async function fixture(): Promise<Fixture> {
  const number = ++sequence;
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,$2) RETURNING id",
      [workspaceId, `Metric review ${number}`],
    )
  ).rows[0].id;
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key,status,
        row_count,column_count,processed_at,original_filename,size_bytes)
       VALUES($1,1,'CSV','metric-review',$2,'READY',1,3,statement_timestamp(),
        'raw.csv',$3) RETURNING id`,
      [datasetId, randomUUID(), (await readFile(rawPath)).byteLength],
    )
  ).rows[0].id;
  const definitions = [
    ["quantity", "BIGINT", { kind: "INTEGER" as const }],
    [
      "unit_price",
      "DECIMAL(18,2)",
      { kind: "DECIMAL" as const, precision: 18, scale: 2 },
    ],
    ["category", "VARCHAR", { kind: "STRING" as const }],
  ] as const;
  const columns: Record<string, string> = {};
  for (const [index, [name, physicalType]] of definitions.entries())
    columns[name] = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
         (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
         VALUES($1,$2,$3,$4,NULL,0) RETURNING id`,
        [versionId, name, physicalType, index + 1],
      )
    ).rows[0].id;
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
    modelName: `metric_review_${number}`,
    label: `Metric review ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  const fields: Fixture["fields"] = {};
  for (const [name, , semanticType] of definitions) {
    const created = await createSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: draft.revision.id,
      datasetColumnId: columns[name],
      name,
      label: name,
      semanticType,
      acceptExplicitConversion: true,
    });
    if (created.outcome !== "CREATED") throw new Error("Expected field");
    fields[name] = { id: created.field.id, key: created.field.fieldKey };
  }
  return { datasetId, revisionId: draft.revision.id, fields };
}

function expression(
  current: Fixture,
  template:
    | "SUM_FIELD"
    | "COUNT_FIELD"
    | "COUNT_DISTINCT_FIELD"
    | "SUM_MULTIPLY_FIELDS",
) {
  const fields = new Map([
    [current.fields.quantity.key, { kind: "INTEGER" as const }],
    [
      current.fields.unit_price.key,
      { kind: "DECIMAL" as const, precision: 18, scale: 2 },
    ],
    [current.fields.category.key, { kind: "STRING" as const }],
  ]);
  const built = buildGovernedMetricExpression(
    {
      template,
      firstFieldKey:
        template === "COUNT_DISTINCT_FIELD"
          ? current.fields.category.key
          : current.fields.quantity.key,
      secondFieldKey:
        template === "SUM_MULTIPLY_FIELDS"
          ? current.fields.unit_price.key
          : undefined,
    },
    fields,
  );
  if (!built.valid) throw new Error("Expected valid expression");
  return built.value.expression;
}

test("reader usa um snapshot read-only, isola workspace e classifica os quatro templates", async () => {
  const current = await fixture();
  for (const [index, template] of [
    "SUM_FIELD",
    "COUNT_FIELD",
    "COUNT_DISTINCT_FIELD",
    "SUM_MULTIPLY_FIELDS",
  ].entries()) {
    const created = await createMetric(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
      name: `metric_${index}`,
      label: `Metric ${index}`,
      expression: expression(
        current,
        template as Parameters<typeof expression>[1],
      ),
    });
    expect(created.outcome).toBe("CREATED");
  }
  const before = await pool.query(
    `SELECT r.updated_at,x.updated_at FROM app.semantic_model_revisions r
     CROSS JOIN app.metrics x WHERE r.id=$1 AND x.semantic_model_revision_id=$1
     ORDER BY x.name`,
    [current.revisionId],
  );
  const result = await readSemanticMetricReview(pool, {
    workspaceId,
    datasetId: current.datasetId,
  });
  expect(result).toMatchObject({
    outcome: "EDITABLE",
    review: {
      metrics: [
        { classification: { template: "SUM_FIELD" } },
        { classification: { template: "COUNT_FIELD" } },
        { classification: { template: "COUNT_DISTINCT_FIELD" } },
        {
          classification: { template: "SUM_MULTIPLY_FIELDS" },
          resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        },
      ],
    },
  });
  expect(
    await readSemanticMetricReview(pool, {
      workspaceId: otherWorkspaceId,
      datasetId: current.datasetId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await pool.query(
      `SELECT r.updated_at,x.updated_at FROM app.semantic_model_revisions r
       CROSS JOIN app.metrics x WHERE r.id=$1 AND x.semantic_model_revision_id=$1
       ORDER BY x.name`,
      [current.revisionId],
    ),
  ).toMatchObject({ rows: before.rows });
  expect(await sha256(rawPath)).toBe(rawHash);
});

test("update preserva metric_key, referências são exatas e remoção não altera fields", async () => {
  const current = await fixture();
  const created = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    name: "quantity_total",
    label: "Quantity total",
    expression: expression(current, "SUM_FIELD"),
  });
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  const updated = await updateMetric(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    metricId: created.metric.id,
    changes: {
      name: "revenue",
      label: "Revenue",
      expression: expression(current, "SUM_MULTIPLY_FIELDS"),
    },
  });
  expect(updated).toMatchObject({
    outcome: "UPDATED",
    metric: { id: created.metric.id, metricKey: created.metric.metricKey },
  });
  expect(
    (
      await pool.query<{ field_key: string }>(
        `SELECT field_key FROM app.metric_field_references
         WHERE metric_id=$1 ORDER BY field_key`,
        [created.metric.id],
      )
    ).rows.map((row) => row.field_key),
  ).toEqual(
    [current.fields.quantity.key, current.fields.unit_price.key].sort(),
  );
  const fieldCount = (
    await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app.semantic_fields WHERE semantic_model_revision_id=$1",
      [current.revisionId],
    )
  ).rows[0].count;
  expect(
    await removeMetric(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
      metricId: created.metric.id,
    }),
  ).toEqual({ outcome: "REMOVED" });
  expect(
    (
      await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app.semantic_fields WHERE semantic_model_revision_id=$1",
        [current.revisionId],
      )
    ).rows[0].count,
  ).toBe(fieldCount);
  expect(await sha256(rawPath)).toBe(rawHash);
});

test("concorrência não duplica nome e publicação torna conteúdo imutável", async () => {
  const current = await fixture();
  const input = {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    name: "quantity_total",
    label: "Quantity total",
    expression: expression(current, "SUM_FIELD"),
  };
  const results = await Promise.all([
    createMetric(pool, input),
    createMetric(pool, input),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "CONFLICT",
    "CREATED",
  ]);
  expect(
    await publishSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
    }),
  ).toMatchObject({ outcome: "PUBLISHED" });
  const created = results.find((result) => result.outcome === "CREATED");
  if (!created || created.outcome !== "CREATED")
    throw new Error("Expected metric");
  expect(
    await updateMetric(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
      metricId: created.metric.id,
      changes: { label: "Changed" },
    }),
  ).toMatchObject({ outcome: "REVISION_NOT_EDITABLE", status: "PUBLISHED" });
  expect(
    await readSemanticMetricReview(pool, {
      workspaceId,
      datasetId: current.datasetId,
    }),
  ).toEqual({ outcome: "NO_DRAFT" });
});

test("AST válido fora dos templates é somente leitura e projeção corrompida retorna BROKEN", async () => {
  const current = await fixture();
  const unsupported = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    name: "sum_plus",
    label: "Sum plus",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "ADD",
        left: { kind: "field", fieldKey: current.fields.quantity.key },
        right: { kind: "field", fieldKey: current.fields.quantity.key },
      },
    },
  });
  if (unsupported.outcome !== "CREATED") throw new Error("Expected metric");
  expect(
    await readSemanticMetricReview(pool, {
      workspaceId,
      datasetId: current.datasetId,
    }),
  ).toMatchObject({
    outcome: "EDITABLE",
    review: { metrics: [{ classification: { kind: "UNSUPPORTED_TEMPLATE" } }] },
  });
  await pool.query(
    "DELETE FROM app.metric_field_references WHERE metric_id=$1",
    [unsupported.metric.id],
  );
  expect(
    await readSemanticMetricReview(pool, {
      workspaceId,
      datasetId: current.datasetId,
    }),
  ).toMatchObject({ outcome: "BROKEN" });
  expect(await sha256(rawPath)).toBe(rawHash);
});
