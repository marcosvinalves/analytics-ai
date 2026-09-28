import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import {
  createSemanticField,
  removeSemanticField,
  updateSemanticField,
} from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import {
  createMetric,
  listMetrics,
  removeMetric,
  updateMetric,
} from "../../src/modules/semantic/infrastructure/metrics.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let organizationId: string;
let workspaceId: string;
let sequence = 0;

type Fixture = {
  revisionId: string;
  fields: Record<string, { id: string; key: string }>;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Metric tests') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id, name) VALUES ($1, 'Metrics') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
  await resetTestDatabase();
});

async function fixture(): Promise<Fixture> {
  const number = ++sequence;
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id, name) VALUES ($1,$2) RETURNING id",
      [workspaceId, `Metrics ${number}`],
    )
  ).rows[0].id;
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id, version_number, source_type, storage_namespace, storage_key)
       VALUES ($1,1,'CSV','metrics',$2) RETURNING id`,
      [datasetId, randomUUID()],
    )
  ).rows[0].id;
  const definitions = [
    ["quantity", "BIGINT"],
    ["unit_price", "DECIMAL(18,2)"],
    ["cost", "DECIMAL(10,2)"],
    ["category", "VARCHAR"],
  ] as const;
  const columns: Record<string, string> = {};
  for (const [index, [name, type]] of definitions.entries())
    columns[name] = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
         (dataset_version_id, physical_name, inferred_type, ordinal_position)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [versionId, name, type, index + 1],
      )
    ).rows[0].id;
  await pool.query(
    `UPDATE app.dataset_versions SET status = 'READY', row_count = 10,
     column_count = 4, processed_at = statement_timestamp() WHERE id = $1`,
    [versionId],
  );
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
    modelName: `metrics_${number}`,
    label: `Metrics ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  const semanticTypes = {
    quantity: { kind: "INTEGER" as const },
    unit_price: { kind: "DECIMAL" as const, precision: 18, scale: 2 },
    cost: { kind: "DECIMAL" as const, precision: 10, scale: 2 },
    category: { kind: "STRING" as const },
  };
  const fields: Fixture["fields"] = {};
  for (const [name, semanticType] of Object.entries(semanticTypes)) {
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
  return { revisionId: draft.revision.id, fields };
}

function revenueExpression(f: Fixture) {
  return {
    version: 1,
    kind: "aggregate",
    op: "SUM",
    expression: {
      kind: "binary",
      op: "MULTIPLY",
      left: { kind: "field", fieldKey: f.fields.quantity.key },
      right: { kind: "field", fieldKey: f.fields.unit_price.key },
    },
  };
}

function input(f: Fixture) {
  return {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    name: "gross_revenue",
    label: "Receita bruta",
    expression: revenueExpression(f),
  };
}

test("migration cria schema, constraints, índices e trigger aprovados", async () => {
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name IN ('metrics','metric_field_references')
     ORDER BY table_name, ordinal_position`,
  );
  expect(columns.rows.map((row) => [row.table_name, row.column_name])).toEqual([
    ["metric_field_references", "metric_id"],
    ["metric_field_references", "semantic_model_revision_id"],
    ["metric_field_references", "field_key"],
    ["metrics", "id"],
    ["metrics", "created_at"],
    ["metrics", "updated_at"],
    ["metrics", "metric_key"],
    ["metrics", "semantic_model_revision_id"],
    ["metrics", "name"],
    ["metrics", "label"],
    ["metrics", "description"],
    ["metrics", "expression"],
  ]);
  const constraints = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid IN ('app.metrics'::regclass,'app.metric_field_references'::regclass)
     ORDER BY conname`,
  );
  expect(constraints.rows.map((row) => row.conname)).toEqual(
    expect.arrayContaining([
      "metrics_revision_fk",
      "metrics_key_unique",
      "metrics_name_unique",
      "metrics_expression_object",
      "metrics_expression_v1_root",
      "metrics_expression_size",
      "metric_field_references_metric_fk",
      "metric_field_references_field_fk",
    ]),
  );
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname='app' AND tablename IN ('metrics','metric_field_references')
     ORDER BY indexname`,
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "metric_field_references_field_idx",
    "metric_field_references_pkey",
    "metrics_id_revision_unique",
    "metrics_key_unique",
    "metrics_name_unique",
    "metrics_pkey",
  ]);
  const foreignKeys = await pool.query<{
    confdeltype: string;
    confupdtype: string;
  }>(
    `SELECT confdeltype, confupdtype FROM pg_constraint
     WHERE conrelid IN ('app.metrics'::regclass,'app.metric_field_references'::regclass)
       AND contype='f'`,
  );
  expect(foreignKeys.rows).toHaveLength(3);
  for (const row of foreignKeys.rows)
    expect(row).toEqual({ confdeltype: "r", confupdtype: "r" });
  const trigger = await pool.query(
    `SELECT 1 FROM pg_trigger
     WHERE tgrelid='app.metrics'::regclass AND tgname='metrics_updated_at'
       AND NOT tgisinternal`,
  );
  expect(trigger.rowCount).toBe(1);
});

test("CRUD preserva metric_key, deriva tipo e mantém referências exatas", async () => {
  const f = await fixture();
  expect(
    await listMetrics(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
    }),
  ).toEqual({
    outcome: "FOUND",
    revisionStatus: "DRAFT",
    metrics: [],
  });
  const created = await createMetric(pool, input(f));
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  expect(created.metric).toMatchObject({
    name: "gross_revenue",
    resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
  });
  const references = await pool.query<{ field_key: string }>(
    "SELECT field_key FROM app.metric_field_references WHERE metric_id = $1 ORDER BY field_key",
    [created.metric.id],
  );
  expect(references.rows.map((row) => row.field_key)).toEqual(
    [f.fields.quantity.key, f.fields.unit_price.key].sort(),
  );
  const updated = await updateMetric(pool, {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    metricId: created.metric.id,
    changes: { name: "revenue", label: "Receita" },
  });
  if (updated.outcome !== "UPDATED") throw new Error("Expected update");
  expect(updated.metric).toMatchObject({
    id: created.metric.id,
    metricKey: created.metric.metricKey,
    name: "revenue",
  });
  expect(
    await updateMetric(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      metricId: created.metric.id,
      changes: { name: "revenue" },
    }),
  ).toMatchObject({ outcome: "UNCHANGED" });
  expect(
    await removeMetric(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      metricId: created.metric.id,
    }),
  ).toEqual({ outcome: "REMOVED" });
});

test("wrong workspace, field desconhecido e raiz escalar falham com segurança", async () => {
  const f = await fixture();
  expect(
    await createMetric(pool, { ...input(f), workspaceId: randomUUID() }),
  ).toEqual({
    outcome: "NOT_FOUND",
  });
  expect(
    await createMetric(pool, {
      ...input(f),
      expression: {
        version: 1,
        kind: "aggregate",
        op: "COUNT",
        expression: { kind: "field", fieldKey: randomUUID() },
      },
    }),
  ).toMatchObject({
    outcome: "INVALID_EXPRESSION",
    error: { code: "UNKNOWN_FIELD" },
  });
  expect(
    await createMetric(pool, {
      ...input(f),
      expression: { kind: "field", fieldKey: f.fields.quantity.key },
    }),
  ).toMatchObject({
    outcome: "INVALID_EXPRESSION",
    error: { code: "ROOT_AGGREGATE_REQUIRED" },
  });
});

test("FKs compostas rejeitam Metric e field_key de revisões diferentes", async () => {
  const a = await fixture();
  const b = await fixture();
  const created = await createMetric(pool, input(a));
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  await expect(
    pool.query(
      `INSERT INTO app.metric_field_references
       (metric_id, semantic_model_revision_id, field_key) VALUES ($1,$2,$3)`,
      [created.metric.id, a.revisionId, b.fields.category.key],
    ),
  ).rejects.toMatchObject({
    code: "23503",
    constraint: "metric_field_references_field_fk",
  });
  await expect(
    pool.query(
      `INSERT INTO app.metric_field_references
       (metric_id, semantic_model_revision_id, field_key) VALUES ($1,$2,$3)`,
      [created.metric.id, b.revisionId, b.fields.category.key],
    ),
  ).rejects.toMatchObject({
    code: "23503",
    constraint: "metric_field_references_metric_fk",
  });
});

test("name é único e JSONB/PostgreSQL mantêm envelope compatível de bytes", async () => {
  const f = await fixture();
  const first = await createMetric(pool, input(f));
  if (first.outcome !== "CREATED") throw new Error("Expected metric");
  expect(await createMetric(pool, input(f))).toEqual({
    outcome: "CONFLICT",
    reason: "NAME_ALREADY_EXISTS",
  });
  const sizes = (
    await pool.query<{ postgres_bytes: number }>(
      "SELECT octet_length(expression::text)::int AS postgres_bytes FROM app.metrics WHERE id = $1",
      [first.metric.id],
    )
  ).rows[0];
  const canonicalBytes = new TextEncoder().encode(
    JSON.stringify(first.metric.expression),
  ).byteLength;
  expect(canonicalBytes).toBeLessThanOrEqual(16 * 1024);
  expect(sizes.postgres_bytes).toBeGreaterThanOrEqual(canonicalBytes);
  expect(sizes.postgres_bytes - canonicalBytes).toBeLessThanOrEqual(1024);
  await expect(
    pool.query(
      `INSERT INTO app.metrics
       (semantic_model_revision_id,name,label,expression)
       VALUES ($1,'oversized','Oversized',$2::jsonb)`,
      [
        f.revisionId,
        JSON.stringify({
          version: 1,
          kind: "aggregate",
          padding: "x".repeat(18_000),
        }),
      ],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "metrics_expression_size",
  });
});

test.each(["PUBLISHED", "ARCHIVED"] as const)(
  "%s bloqueia mutações",
  async (status) => {
    const f = await fixture();
    const created = await createMetric(pool, input(f));
    if (created.outcome !== "CREATED") throw new Error("Expected metric");
    await pool.query(
      "UPDATE app.semantic_model_revisions SET status='PUBLISHED',published_at=statement_timestamp() WHERE id=$1",
      [f.revisionId],
    );
    if (status === "ARCHIVED")
      await pool.query(
        "UPDATE app.semantic_model_revisions SET status='ARCHIVED' WHERE id=$1",
        [f.revisionId],
      );
    expect(await createMetric(pool, { ...input(f), name: "other" })).toEqual({
      outcome: "REVISION_NOT_EDITABLE",
      status,
    });
    expect(
      await updateMetric(pool, {
        workspaceId,
        semanticModelRevisionId: f.revisionId,
        metricId: created.metric.id,
        changes: { label: "Other" },
      }),
    ).toEqual({ outcome: "REVISION_NOT_EDITABLE", status });
    expect(
      await removeMetric(pool, {
        workspaceId,
        semanticModelRevisionId: f.revisionId,
        metricId: created.metric.id,
      }),
    ).toEqual({ outcome: "REVISION_NOT_EDITABLE", status });
  },
);

test("field referenciado não pode ser removido e mudança de tipo inválida é bloqueada", async () => {
  const f = await fixture();
  const created = await createMetric(pool, input(f));
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  expect(
    await removeSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: f.fields.quantity.id,
    }),
  ).toEqual({ outcome: "FIELD_IN_USE", metricKey: created.metric.metricKey });

  const decimalMetric = await createMetric(pool, {
    ...input(f),
    name: "margin_base",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "MULTIPLY",
        left: { kind: "field", fieldKey: f.fields.unit_price.key },
        right: { kind: "field", fieldKey: f.fields.cost.key },
      },
    },
  });
  if (decimalMetric.outcome !== "CREATED") throw new Error("Expected metric");
  expect(
    await updateSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: f.fields.unit_price.id,
      changes: { semanticType: { kind: "DECIMAL", precision: 30, scale: 2 } },
    }),
  ).toMatchObject({
    outcome: "FIELD_CHANGE_INVALIDATES_METRIC",
    metricKey: decimalMetric.metric.metricKey,
    error: { code: "DECIMAL_PRECISION_OVERFLOW" },
  });
  expect(
    await updateSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: f.fields.quantity.id,
      changes: { label: "Quantidade vendida" },
    }),
  ).toMatchObject({ outcome: "UPDATED" });
  const listed = await listMetrics(pool, {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
  });
  expect(listed.outcome).toBe("FOUND");
  if (listed.outcome !== "FOUND") throw new Error("Expected metrics");
  expect(listed.metrics.map((metric) => metric.id)).toContain(
    created.metric.id,
  );
});

test("remover Metric libera remoção do field", async () => {
  const f = await fixture();
  const created = await createMetric(pool, input(f));
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  await removeMetric(pool, {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    metricId: created.metric.id,
  });
  expect(
    await removeSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: f.fields.quantity.id,
    }),
  ).toEqual({ outcome: "REMOVED" });
});

test("criação concorrente com mesmo name produz CREATED e CONFLICT", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  const tag = `metric-race-${randomUUID()}`;
  const writers = ["a", "b"].map(
    (suffix) =>
      new Pool({
        ...getDatabaseConfig(testDatabaseUrl()),
        max: 1,
        application_name: `${tag}-${suffix}`,
      }),
  );
  let attempts:
    | Promise<PromiseSettledResult<Awaited<ReturnType<typeof createMetric>>>[]>
    | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id=$1 FOR UPDATE",
      [f.revisionId],
    );
    attempts = Promise.allSettled([
      createMetric(writers[0], input(f)),
      createMetric(writers[1], input(f)),
    ]);
    await expectBlocked(tag, 2);
    await blocker.query("COMMIT");
    const results = (await attempts).map((item) => {
      if (item.status === "rejected") throw item.reason;
      return item.value.outcome;
    });
    expect(results.sort()).toEqual(["CONFLICT", "CREATED"]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await attempts;
    await Promise.all(writers.map((writer) => writer.end()));
  }
});

test("updates concorrentes são serializados e aplicados sobre o estado bloqueado", async () => {
  const f = await fixture();
  const created = await createMetric(pool, input(f));
  if (created.outcome !== "CREATED") throw new Error("Expected metric");
  const blocker = await pool.connect();
  const tag = `metric-update-${randomUUID()}`;
  const writers = ["a", "b"].map(
    (suffix) =>
      new Pool({
        ...getDatabaseConfig(testDatabaseUrl()),
        max: 1,
        application_name: `${tag}-${suffix}`,
      }),
  );
  let first: ReturnType<typeof updateMetric> | undefined;
  let second: ReturnType<typeof updateMetric> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id=$1 FOR UPDATE",
      [f.revisionId],
    );
    first = updateMetric(writers[0], {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      metricId: created.metric.id,
      changes: { label: "Primeiro" },
    });
    await expectBlocked(tag, 1);
    second = updateMetric(writers[1], {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      metricId: created.metric.id,
      changes: { description: "Segundo" },
    });
    await expectBlocked(tag, 2);
    await blocker.query("COMMIT");
    expect(await first).toMatchObject({ outcome: "UPDATED" });
    expect(await second).toMatchObject({ outcome: "UPDATED" });
    expect(
      await listMetrics(pool, {
        workspaceId,
        semanticModelRevisionId: f.revisionId,
      }),
    ).toMatchObject({
      outcome: "FOUND",
      metrics: [{ label: "Primeiro", description: "Segundo" }],
    });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await first;
    await second;
    await Promise.all(writers.map((writer) => writer.end()));
  }
});

test("lock timeout confirma rollback sem Metric ou referências parciais", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id=$1 FOR UPDATE",
      [f.revisionId],
    );
    await expect(createMetric(pool, input(f))).rejects.toThrow(
      "METRIC_WRITE_FAILED",
    );
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.metrics WHERE semantic_model_revision_id=$1",
          [f.revisionId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

async function expectBlocked(tag: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'`,
      [[`${tag}-a`, `${tag}-b`]],
    );
    if (result.rows[0].count === count) return;
    await delay(10);
  }
  throw new Error(`Expected ${count} blocked PostgreSQL sessions`);
}
