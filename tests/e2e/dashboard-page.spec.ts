import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { createDashboard } from "../../src/modules/dashboard/infrastructure/dashboards.ts";
import { createDashboardWidget } from "../../src/modules/dashboard/infrastructure/dashboard-widgets.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import {
  resetTestDatabase,
  testDatabaseUrl,
} from "../integration/helpers/database.ts";

const workspaceId = "10000000-0000-4000-8000-000000000029";
const organizationId = "20000000-0000-4000-8000-000000000029";
const storageRoot = path.resolve(".local/dashboard-e2e-storage");
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
let dashboardId: string;
let crossWorkspaceDashboardId: string;
let datasetId: string;
let rawPath: string;
let metadataBefore: string;
let rawHashBefore: string;

async function sha256(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function metadataSnapshot(): Promise<string> {
  const tables = [
    ["organizations", '"id"'],
    ["workspaces", '"id"'],
    ["datasets", '"id"'],
    ["dataset_versions", '"id"'],
    ["dataset_columns", '"id"'],
    ["semantic_models", '"id"'],
    ["semantic_model_revisions", '"id"'],
    ["semantic_fields", '"id"'],
    ["metrics", '"id"'],
    ["metric_field_references", '"metric_id", "field_key"'],
    ["dashboards", '"id"'],
    ["dashboard_widgets", '"id"'],
  ] as const;
  return JSON.stringify(
    await Promise.all(
      tables.map(async ([table, primaryKey]) =>
        (
          await pool.query(
            `SELECT to_jsonb(t) AS row FROM app.${table} t ORDER BY ${primaryKey}`,
          )
        ).rows.map((row) => row.row),
      ),
    ),
  );
}

async function createReadyDataset(name: string, withColumns: boolean) {
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,$2) RETURNING id",
      [workspaceId, name],
    )
  ).rows[0].id;
  const versionId = randomUUID();
  const storageKey = rawStorageKey(workspaceId, versionId);
  const bytes = await readFile(fixturePath);
  const filename = path.join(storageRoot, storageKey);
  await mkdir(path.dirname(filename), { recursive: true });
  await copyFile(fixturePath, filename);
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'vendas_teste_analytics_ai.csv',$4)`,
    [versionId, datasetId, storageKey, bytes.length],
  );
  const columns = new Map<string, string>();
  if (withColumns) {
    for (let index = 0; index < physicalColumns.length; index += 1) {
      const [physicalName, inferredType] = physicalColumns[index];
      const id = (
        await pool.query<{ id: string }>(
          `INSERT INTO app.dataset_columns
            (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
           VALUES($1,$2,$3,$4,NULL,0) RETURNING id`,
          [versionId, physicalName, inferredType, index + 1],
        )
      ).rows[0].id;
      columns.set(physicalName, id);
    }
  }
  await pool.query(
    `UPDATE app.dataset_versions SET status='READY',row_count=20,column_count=$2,
       processed_at=statement_timestamp() WHERE id=$1`,
    [versionId, withColumns ? physicalColumns.length : 0],
  );
  return { datasetId, versionId, columns, filename };
}

test.beforeAll(async () => {
  await resetTestDatabase();
  await rm(storageRoot, { recursive: true, force: true });
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await pool.query(
    "INSERT INTO app.organizations(id,name) VALUES($1,'Dashboard E2E')",
    [organizationId],
  );
  await pool.query(
    `INSERT INTO app.workspaces(id,organization_id,name)
     VALUES($1,$2,'Dashboard E2E'),
       ('30000000-0000-4000-8000-000000000029',$2,'Outro workspace')`,
    [workspaceId, organizationId],
  );

  const source = await createReadyDataset("Vendas E2E", true);
  datasetId = source.datasetId;
  rawPath = source.filename;
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId: source.datasetId,
    datasetVersionId: source.versionId,
    modelName: "sales_e2e",
    label: "Vendas E2E",
  });
  if (draft.outcome !== "CREATED")
    throw new Error("Fixture semantic draft failed");

  const fieldKeys = new Map<string, string>();
  for (const field of [
    ["data_venda", "date", "Data", { kind: "DATE" as const }, false],
    ["cidade", "city", "Cidade", { kind: "STRING" as const }, false],
    [
      "quantidade",
      "quantity",
      "Quantidade",
      { kind: "INTEGER" as const },
      false,
    ],
    [
      "preco_unitario",
      "unit_price",
      "Preço unitário",
      { kind: "DECIMAL" as const, precision: 18, scale: 2 },
      true,
    ],
  ] as const) {
    const created = await createSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: draft.revision.id,
      datasetColumnId: source.columns.get(field[0])!,
      name: field[1],
      label: field[2],
      semanticType: field[3],
      ...(field[4] ? { acceptExplicitConversion: true } : {}),
    });
    if (created.outcome !== "CREATED")
      throw new Error("Fixture semantic field failed");
    fieldKeys.set(field[1], created.field.fieldKey);
  }

  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
    name: "revenue",
    label: "Receita",
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
  if (metric.outcome !== "CREATED") throw new Error("Fixture metric failed");
  const published = await publishSemanticModelRevision(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
  });
  if (published.outcome !== "PUBLISHED")
    throw new Error("Fixture publication failed");

  const dashboard = await createDashboard(pool, {
    workspaceId,
    name: "Visão comercial E2E",
    description: "Indicadores reais do fluxo de vendas.",
  });
  if (dashboard.outcome !== "CREATED")
    throw new Error("Fixture dashboard failed");
  dashboardId = dashboard.dashboard.id;

  const revenue = metric.metric.metricKey;
  const city = fieldKeys.get("city")!;
  const date = fieldKeys.get("date")!;
  const definitions = [
    {
      query: { version: 1, metrics: [revenue] },
      spec: {
        version: 1,
        type: "KPI",
        value: { role: "METRIC", key: revenue },
      },
      layout: { x: 0, y: 0, width: 3, height: 2 },
    },
    {
      query: { version: 1, metrics: [revenue], dimensions: [city] },
      spec: { version: 1, type: "TABLE" },
      layout: { x: 3, y: 0, width: 3, height: 2 },
    },
    {
      query: { version: 1, metrics: [revenue], dimensions: [city] },
      spec: {
        version: 1,
        type: "BAR",
        category: { role: "DIMENSION", key: city },
        value: { role: "METRIC", key: revenue },
      },
      layout: { x: 6, y: 0, width: 3, height: 2 },
    },
    {
      query: {
        version: 1,
        metrics: [revenue],
        dimensions: [date],
        orderBy: [
          { target: { kind: "DIMENSION", fieldKey: date }, direction: "ASC" },
        ],
      },
      spec: {
        version: 1,
        type: "LINE",
        x: { role: "DIMENSION", key: date },
        y: { role: "METRIC", key: revenue },
      },
      layout: { x: 9, y: 0, width: 3, height: 2 },
    },
    {
      query: {
        version: 1,
        metrics: [revenue],
        dimensions: [city],
        filters: [
          {
            fieldKey: city,
            op: "EQ",
            value: { type: "STRING", value: "Cidade inexistente" },
          },
        ],
      },
      spec: { version: 1, type: "TABLE" },
      layout: { x: 0, y: 2, width: 4, height: 2 },
    },
  ] as const;

  for (const definition of definitions) {
    const created = await createDashboardWidget(pool, {
      workspaceId,
      dashboardId,
      semanticModelId: draft.model.id,
      semanticQuery: definition.query,
      visualizationSpec: definition.spec,
      layout: definition.layout,
    });
    if (created.outcome !== "CREATED") throw new Error("Fixture widget failed");
  }

  const broken = await createDashboardWidget(pool, {
    workspaceId,
    dashboardId,
    semanticModelId: draft.model.id,
    semanticQuery: { version: 1, metrics: [revenue] },
    visualizationSpec: { version: 1, type: "TABLE" },
    layout: { x: 4, y: 2, width: 4, height: 2 },
  });
  if (broken.outcome !== "CREATED")
    throw new Error("Fixture broken widget failed");
  await pool.query(
    "ALTER TABLE app.dashboard_widgets DROP CONSTRAINT dashboard_widgets_layout_width_check",
  );
  await pool.query(
    "UPDATE app.dashboard_widgets SET layout_width=0 WHERE id=$1",
    [broken.widget.id],
  );

  const unpublishedSource = await createReadyDataset(
    "Vendas não publicadas",
    true,
  );
  const unpublished = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId: unpublishedSource.datasetId,
    datasetVersionId: unpublishedSource.versionId,
    modelName: "unpublished_e2e",
    label: "Modelo não publicado",
  });
  if (unpublished.outcome !== "CREATED")
    throw new Error("Fixture unpublished model failed");
  const errorWidget = await createDashboardWidget(pool, {
    workspaceId,
    dashboardId,
    semanticModelId: unpublished.model.id,
    semanticQuery: { version: 1, metrics: [revenue] },
    visualizationSpec: { version: 1, type: "TABLE" },
    layout: { x: 8, y: 2, width: 4, height: 2 },
  });
  if (errorWidget.outcome !== "CREATED")
    throw new Error("Fixture error widget failed");

  crossWorkspaceDashboardId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dashboards(workspace_id,name,description)
       VALUES('30000000-0000-4000-8000-000000000029','Segredo cross-workspace','Não revelar') RETURNING id`,
    )
  ).rows[0].id;
  metadataBefore = await metadataSnapshot();
  rawHashBefore = await sha256(rawPath);
});

test.afterAll(async () => {
  try {
    expect(await metadataSnapshot()).toBe(metadataBefore);
    expect(await sha256(rawPath)).toBe(rawHashBefore);
  } finally {
    await pool?.end();
    await rm(storageRoot, { recursive: true, force: true });
    await resetTestDatabase();
  }
});

test("consome Dashboard real, estados, explicação e refresh", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(`/dashboards/${dashboardId}`);

  await expect(
    page.getByRole("heading", { name: "Visão comercial E2E" }),
  ).toBeVisible();
  await expect(page.getByText("2.059,61", { exact: true })).toBeVisible();
  await expect(page.locator('[data-chart-type="BAR"]')).toBeVisible();
  await expect(page.locator('[data-chart-type="LINE"]')).toBeVisible();
  await expect(
    page.getByText("Nenhum dado corresponde a esta configuração."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Widgets que precisam de atenção" }),
  ).toBeVisible();
  await expect(page.getByText("Posicionamento inválido")).toBeVisible();
  await expect(page.getByText("Modelo ainda não publicado")).toBeVisible();

  const explanationButton = page
    .getByRole("button", { name: "Como foi calculado?" })
    .first();
  await explanationButton.focus();
  await explanationButton.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Como foi calculado?" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Soma de (Quantidade × Preço unitário)"),
  ).toBeVisible();
  await expect(dialog.getByText("Precisão: exata")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(explanationButton).toBeFocused();

  const refreshRequest = page.waitForRequest(
    (request) =>
      request.url().includes(`/dashboards/${dashboardId}`) &&
      request.headers().rsc === "1",
  );
  await page.getByRole("button", { name: "Atualizar" }).click();
  await refreshRequest;
  await expect(
    page.getByRole("heading", { name: "Visão comercial E2E" }),
  ).toBeVisible();

  const html = await page.locator("body").innerText();
  for (const forbidden of [
    "SEMANTIC_QUERY_INVALID",
    "MODEL_NOT_PUBLISHED",
    "SELECT ",
    "DuckDB",
    storageRoot,
    workspaceId,
  ])
    expect(html).not.toContain(forbidden);
  expect(browserErrors).toEqual([]);
});

test("mantém um único shell nas rotas reais e a navegação ativa", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const routes = [
    { path: "/", active: "Início" },
    { path: "/data", active: "Dados" },
    { path: "/data/upload", active: "Dados" },
    { path: `/data/datasets/${datasetId}`, active: "Dados" },
    { path: `/dashboards/${dashboardId}`, active: null },
  ];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.locator("[data-app-shell]")).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("[data-primary-navigation]")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      page.locator('[data-primary-navigation] [aria-current="page"]'),
    ).toHaveCount(route.active ? 1 : 0);
    if (route.active)
      await expect(
        page.locator('[data-primary-navigation] [aria-current="page"]'),
      ).toHaveText(route.active);
  }
  expect(browserErrors).toEqual([]);
});

test("aplica a geometria desktop e mobile do shell e do Dashboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboards/${dashboardId}`);
  const desktop = await page.evaluate(() => {
    const topbar = document.querySelector("[data-app-shell] > header")!;
    const nav = document.querySelector("[data-primary-navigation]")!;
    const grid = document.querySelector('[aria-label="Widgets do Dashboard"]')!;
    return {
      topbarHeight: Math.round(topbar.getBoundingClientRect().height),
      navWidth: Math.round(nav.getBoundingClientRect().width),
      gridColumns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
    };
  });
  expect(desktop).toEqual({ topbarHeight: 56, navWidth: 224, gridColumns: 12 });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const topbar = document.querySelector("[data-app-shell] > header")!;
    const nav = document.querySelector("[data-primary-navigation]")!;
    const content = document.querySelector("main")!;
    return {
      topbarHeight: Math.round(topbar.getBoundingClientRect().height),
      navDirection: getComputedStyle(nav).flexDirection,
      contentPadding: getComputedStyle(content).paddingLeft,
    };
  });
  expect(mobile).toEqual({
    topbarHeight: 52,
    navDirection: "row",
    contentPadding: "16px",
  });
});

test("renderiza a loading boundary uma vez dentro do shell", async ({
  page,
}) => {
  const navigation = page.goto(`/dashboards/${dashboardId}`, {
    waitUntil: "commit",
  });
  await expect(
    page.getByRole("heading", { name: "Carregando Dashboard…" }),
  ).toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveCount(1);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("[data-primary-navigation]")).toHaveCount(1);
  await navigation;
  await expect(
    page.getByRole("heading", { name: "Visão comercial E2E" }),
  ).toBeVisible();
});

test("renderiza a error boundary uma vez dentro do shell", async ({ page }) => {
  await page.addInitScript(() => {
    class FailingResizeObserver {
      constructor() {
        throw new Error("forced browser-only ResizeObserver failure");
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: FailingResizeObserver,
    });
  });
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(
    page.getByRole("heading", {
      name: "Dashboard temporariamente indisponível",
    }),
  ).toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveCount(1);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("[data-primary-navigation]")).toHaveCount(1);
});

test("mantém Home, Dados, Upload e Dataset utilizáveis no mobile", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Início" })).toBeVisible();
  await page.goto("/data");
  await expect(page.getByRole("heading", { name: "Dados" })).toBeVisible();
  await expect(page.getByText("Pronto", { exact: true }).first()).toBeVisible();
  await page.goto("/data/upload");
  await expect(page.getByRole("heading", { name: "Enviar CSV" })).toBeVisible();
  await expect(page.getByLabel("Arquivo CSV")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toBeVisible();
  await page.goto(`/data/datasets/${datasetId}`);
  const preview = page.getByRole("region", { name: "Linhas do preview" });
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("projeta os cards em stack no mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/dashboards/${dashboardId}`);
  const cards = page.locator("article");
  await expect(cards).toHaveCount(7);
  const boxes = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }),
  );
  expect(new Set(boxes.slice(0, 6).map((box) => box.left)).size).toBe(1);
  for (let index = 1; index < 6; index += 1)
    expect(boxes[index].top).toBeGreaterThan(boxes[index - 1].top);
});

test("mantém NOT_FOUND cross-workspace terminal e opaco", async ({ page }) => {
  const response = await page.goto(`/dashboards/${crossWorkspaceDashboardId}`);
  expect(response?.status()).toBeGreaterThanOrEqual(200);
  await expect(
    page.getByRole("heading", { name: "Dashboard não encontrado" }),
  ).toBeVisible();
  await expect(page.getByText("Segredo cross-workspace")).toHaveCount(0);
  await expect(page.getByText("Não revelar")).toHaveCount(0);
  await expect(page.locator("[data-app-shell]")).toHaveCount(1);
  await expect(page.locator("main")).toHaveCount(1);
});
