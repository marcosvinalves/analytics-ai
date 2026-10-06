import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { executeDashboard } from "../../src/modules/dashboard/application/execute-dashboard.ts";
import { createDashboard } from "../../src/modules/dashboard/infrastructure/dashboards.ts";
import { createDashboardWidget } from "../../src/modules/dashboard/infrastructure/dashboard-widgets.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

vi.mock("server-only", () => ({}));

const fixturePath = path.resolve(
  "tests/fixtures/query/vendas_teste_analytics_ai.csv",
);
const physicalColumns = [
  ["data_venda", "DATE"],
  ["produto", "VARCHAR"],
  ["categoria", "VARCHAR"],
  ["cidade", "VARCHAR"],
  ["quantidade", "BIGINT"],
  ["preco_unitario", "DOUBLE"],
  ["receita", "DOUBLE"],
] as const;

let pool: Pool;
let storageRoot: string;
let rawPath: string;
let workspaceId: string;
let otherWorkspaceId: string;
let dashboardId: string;
let emptyDashboardId: string;

async function sha256(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function metadataSnapshot(): Promise<unknown> {
  return (
    await pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'organizations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.organizations x),
    'workspaces',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.workspaces x),
    'datasets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.datasets x),
    'dataset_versions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dataset_versions x),
    'dataset_columns',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dataset_columns x),
    'semantic_models',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_models x),
    'semantic_model_revisions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_model_revisions x),
    'semantic_fields',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_fields x),
    'metrics',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.metrics x),
    'metric_field_references',(SELECT jsonb_agg(to_jsonb(x) ORDER BY metric_id,field_key) FROM app.metric_field_references x),
    'dashboards',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dashboards x),
    'dashboard_widgets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dashboard_widgets x)
  ) AS state`)
  ).rows[0].state;
}

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "dashboard-execution-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", storageRoot);
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES('Dashboard execution') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string; name: string }>(
    `INSERT INTO app.workspaces(organization_id,name)
     VALUES($1,'Dashboard execution'),($1,'Other execution workspace') RETURNING id,name`,
    [organizationId],
  );
  workspaceId = workspaces.rows.find(
    (row) => row.name === "Dashboard execution",
  )!.id;
  otherWorkspaceId = workspaces.rows.find(
    (row) => row.name === "Other execution workspace",
  )!.id;

  const bytes = await readFile(fixturePath);
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,'Dashboard sales') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id;
  const versionId = randomUUID();
  const storageKey = rawStorageKey(workspaceId, versionId);
  rawPath = path.join(storageRoot, storageKey);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await copyFile(fixturePath, rawPath);
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'vendas_teste_analytics_ai.csv',$4)`,
    [versionId, datasetId, storageKey, bytes.length],
  );
  const columnIds = new Map<string, string>();
  for (let index = 0; index < physicalColumns.length; index += 1) {
    const [name, type] = physicalColumns[index];
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
        (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
       VALUES($1,$2,$3,$4,NULL,0) RETURNING id`,
        [versionId, name, type, index + 1],
      )
    ).rows[0].id;
    columnIds.set(name, id);
  }
  await pool.query(
    `UPDATE app.dataset_versions SET status='READY',row_count=20,column_count=7,
     processed_at=statement_timestamp() WHERE id=$1`,
    [versionId],
  );

  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
    modelName: "dashboard_sales",
    label: "Dashboard sales",
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  const fieldKeys = new Map<string, string>();
  for (const field of [
    ["data_venda", "date", "Sale date", { kind: "DATE" as const }, false],
    ["cidade", "city", "City", { kind: "STRING" as const }, false],
    ["quantidade", "quantity", "Quantity", { kind: "INTEGER" as const }, false],
    [
      "preco_unitario",
      "unit_price",
      "Unit price",
      { kind: "DECIMAL" as const, precision: 18, scale: 2 },
      true,
    ],
  ] as const) {
    const created = await createSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: draft.revision.id,
      datasetColumnId: columnIds.get(field[0])!,
      name: field[1],
      label: field[2],
      semanticType: field[3],
      ...(field[4] ? { acceptExplicitConversion: true } : {}),
    });
    if (created.outcome !== "CREATED") throw new Error("Expected field");
    fieldKeys.set(field[1], created.field.fieldKey);
  }
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
    name: "revenue",
    label: "Revenue",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "MULTIPLY",
        left: { kind: "field", fieldKey: fieldKeys.get("quantity")! },
        right: { kind: "field", fieldKey: fieldKeys.get("unit_price")! },
      },
    },
  });
  if (metric.outcome !== "CREATED") throw new Error("Expected metric");
  const published = await publishSemanticModelRevision(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
  });
  if (published.outcome !== "PUBLISHED")
    throw new Error("Expected publication");

  const dashboard = await createDashboard(pool, {
    workspaceId,
    name: "Sales dashboard",
  });
  const emptyDashboard = await createDashboard(pool, {
    workspaceId,
    name: "Empty dashboard",
  });
  if (dashboard.outcome !== "CREATED" || emptyDashboard.outcome !== "CREATED")
    throw new Error("Expected dashboards");
  dashboardId = dashboard.dashboard.id;
  emptyDashboardId = emptyDashboard.dashboard.id;
  const revenue = metric.metric.metricKey;
  const definitions = [
    {
      x: 0,
      y: 0,
      query: { version: 1, metrics: [revenue] },
      spec: {
        version: 1,
        type: "KPI",
        value: { role: "METRIC", key: revenue },
      },
    },
    {
      x: 3,
      y: 0,
      query: {
        version: 1,
        metrics: [revenue],
        dimensions: [fieldKeys.get("city")!],
      },
      spec: { version: 1, type: "TABLE" },
    },
    {
      x: 6,
      y: 0,
      query: {
        version: 1,
        metrics: [revenue],
        dimensions: [fieldKeys.get("city")!],
      },
      spec: {
        version: 1,
        type: "BAR",
        category: { role: "DIMENSION", key: fieldKeys.get("city")! },
        value: { role: "METRIC", key: revenue },
      },
    },
    {
      x: 9,
      y: 0,
      query: {
        version: 1,
        metrics: [revenue],
        dimensions: [fieldKeys.get("date")!],
        orderBy: [
          {
            target: { kind: "DIMENSION", fieldKey: fieldKeys.get("date")! },
            direction: "ASC",
          },
        ],
      },
      spec: {
        version: 1,
        type: "LINE",
        x: { role: "DIMENSION", key: fieldKeys.get("date")! },
        y: { role: "METRIC", key: revenue },
      },
    },
    {
      x: 0,
      y: 2,
      query: { version: 1, metrics: [revenue] },
      spec: { version: 1, type: "TABLE" },
      broken: true,
    },
  ] as const;
  for (const definition of definitions) {
    const widget = await createDashboardWidget(pool, {
      workspaceId,
      dashboardId,
      semanticModelId: draft.model.id,
      semanticQuery: definition.query,
      visualizationSpec: definition.spec,
      layout: { x: definition.x, y: definition.y, width: 3, height: 2 },
    });
    if (widget.outcome !== "CREATED") throw new Error("Expected widget");
    if ("broken" in definition)
      await pool.query(
        "UPDATE app.dashboard_widgets SET semantic_query='{\"version\":99}'::jsonb WHERE id=$1",
        [widget.widget.id],
      );
  }
});

afterAll(async () => {
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  await resetTestDatabase();
}, 30_000);

test("executa Dashboard real ordenado, isolado, concorrente e read-only", async () => {
  const metadataBefore = await metadataSnapshot();
  const hashBefore = await sha256(rawPath);
  const input = { workspaceId, dashboardId };
  const executions = await Promise.all([
    executeDashboard(pool, input),
    executeDashboard(pool, input),
  ]);
  expect(executions[0]).toEqual(executions[1]);
  const output = executions[0];
  expect(output.status).toBe("COMPLETED");
  if (output.status !== "COMPLETED") throw new Error("Expected COMPLETED");
  expect(output.widgets.map((item) => item.layout)).toEqual([
    { x: 0, y: 0, width: 3, height: 2 },
    { x: 3, y: 0, width: 3, height: 2 },
    { x: 6, y: 0, width: 3, height: 2 },
    { x: 9, y: 0, width: 3, height: 2 },
    { x: 0, y: 2, width: 3, height: 2 },
  ]);
  expect(output.widgets.map((item) => item.result.status)).toEqual([
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "BROKEN",
  ]);
  expect(
    output.widgets
      .slice(0, 4)
      .map((item) =>
        item.result.status === "SUCCESS" ? item.result.viewModel.type : null,
      ),
  ).toEqual(["KPI", "TABLE", "BAR", "LINE"]);
  expect(output.widgets[0].result).toMatchObject({
    status: "SUCCESS",
    viewModel: {
      type: "KPI",
      state: "VALUE",
      value: { type: "DECIMAL", value: "2059.61", exactness: "EXACT" },
    },
    explanation: { metrics: [{ label: "Revenue", numericSemantics: "EXACT" }] },
  });
  for (const item of output.widgets.slice(0, 4))
    expect(item.result).toHaveProperty("explanation");
  expect(output.widgets[4].result).toMatchObject({
    status: "BROKEN",
    reason: "SEMANTIC_QUERY_INVALID",
  });

  await expect(
    executeDashboard(pool, { workspaceId: otherWorkspaceId, dashboardId }),
  ).resolves.toEqual({ status: "NOT_FOUND" });
  await expect(
    executeDashboard(pool, { workspaceId, dashboardId: emptyDashboardId }),
  ).resolves.toEqual({
    status: "COMPLETED",
    dashboardId: emptyDashboardId,
    widgets: [],
  });
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  expect(await sha256(rawPath)).toBe(hashBefore);
});
