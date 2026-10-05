import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import {
  createDashboard,
  deleteDashboard,
} from "../../src/modules/dashboard/infrastructure/dashboards.ts";
import {
  createDashboardWidget,
  deleteDashboardWidget,
  getDashboardWidget,
  listDashboardWidgets,
  updateDashboardWidget,
} from "../../src/modules/dashboard/infrastructure/dashboard-widgets.ts";
import type { SaveDashboardWidgetInput } from "../../src/modules/dashboard/domain/dashboard-widget.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let otherWorkspaceId: string;
let semanticModelId: string;
let otherSemanticModelId: string;

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Widget tests') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string; name: string }>(
    `INSERT INTO app.workspaces(organization_id,name)
     VALUES ($1,'Widgets A'),($1,'Widgets B') RETURNING id,name`,
    [organizationId],
  );
  workspaceId = workspaces.rows.find((row) => row.name === "Widgets A")!.id;
  otherWorkspaceId = workspaces.rows.find(
    (row) => row.name === "Widgets B",
  )!.id;
  const datasets = await pool.query<{ id: string; workspace_id: string }>(
    `INSERT INTO app.datasets(workspace_id,name)
     VALUES ($1,'Dataset A'),($2,'Dataset B') RETURNING id,workspace_id`,
    [workspaceId, otherWorkspaceId],
  );
  semanticModelId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.semantic_models(dataset_id,name) VALUES ($1,'model_a') RETURNING id",
      [datasets.rows.find((row) => row.workspace_id === workspaceId)!.id],
    )
  ).rows[0].id;
  otherSemanticModelId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.semantic_models(dataset_id,name) VALUES ($1,'model_b') RETURNING id",
      [datasets.rows.find((row) => row.workspace_id === otherWorkspaceId)!.id],
    )
  ).rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
  await resetTestDatabase();
});

async function dashboard(name: string, targetWorkspace = workspaceId) {
  const result = await createDashboard(pool, {
    workspaceId: targetWorkspace,
    name,
  });
  if (result.outcome !== "CREATED")
    throw new Error(`Expected CREATED, got ${result.outcome}`);
  return result.dashboard;
}

function widgetInput(
  dashboardId: string,
  x: number,
  y: number,
  modelId = semanticModelId,
): SaveDashboardWidgetInput {
  return {
    workspaceId,
    dashboardId,
    semanticModelId: modelId,
    semanticQuery: { version: 1, metrics: [randomUUID()] },
    visualizationSpec: { version: 1, type: "TABLE" },
    layout: { x, y, width: 1, height: 1 },
  };
}

async function created(input: SaveDashboardWidgetInput) {
  const result = await createDashboardWidget(pool, input);
  if (result.outcome !== "CREATED")
    throw new Error(`Expected CREATED, got ${result.outcome}`);
  return result.widget;
}

async function assertAggregateValid(dashboardId: string) {
  const result = await pool.query<{ count: number; overlaps: number }>(
    `SELECT count(*)::int AS count,
      (SELECT count(*)::int FROM app.dashboard_widgets a
       JOIN app.dashboard_widgets b ON a.dashboard_id=b.dashboard_id AND a.id < b.id
       WHERE a.dashboard_id=$1
         AND a.layout_x < b.layout_x+b.layout_width
         AND a.layout_x+a.layout_width > b.layout_x
         AND a.layout_y < b.layout_y+b.layout_height
         AND a.layout_y+a.layout_height > b.layout_y) AS overlaps
     FROM app.dashboard_widgets WHERE dashboard_id=$1`,
    [dashboardId],
  );
  expect(result.rows[0].count).toBeLessThanOrEqual(12);
  expect(result.rows[0].overlaps).toBe(0);
}

async function databaseFailure(statement: string, parameters: unknown[]) {
  try {
    await pool.query(statement, parameters);
    throw new Error("Expected PostgreSQL failure");
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error)) throw error;
    return error as { code: string; constraint?: string };
  }
}

test("nona migration cria catálogo, constraints, índices e trigger", async () => {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='app' AND table_name='dashboard_widgets' ORDER BY ordinal_position`,
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    "id",
    "dashboard_id",
    "semantic_model_id",
    "semantic_query",
    "visualization_spec",
    "layout_x",
    "layout_y",
    "layout_width",
    "layout_height",
    "created_at",
    "updated_at",
  ]);
  const constraints = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid='app.dashboard_widgets'::regclass AND contype <> 'n' ORDER BY conname`,
  );
  expect(constraints.rows.map((row) => row.conname)).toEqual(
    [
      "dashboard_widgets_dashboard_fk",
      "dashboard_widgets_layout_height_check",
      "dashboard_widgets_layout_horizontal_check",
      "dashboard_widgets_layout_width_check",
      "dashboard_widgets_layout_x_check",
      "dashboard_widgets_layout_y_check",
      "dashboard_widgets_layout_vertical_check",
      "dashboard_widgets_pkey",
      "dashboard_widgets_query_object",
      "dashboard_widgets_semantic_model_fk",
      "dashboard_widgets_visualization_object",
    ].sort(),
  );
  const indexes = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname='app' AND tablename='dashboard_widgets' ORDER BY indexname",
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "dashboard_widgets_dashboard_layout_idx",
    "dashboard_widgets_pkey",
    "dashboard_widgets_semantic_model_idx",
  ]);
  const triggers = await pool.query<{ proname: string }>(
    `SELECT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE t.tgrelid='app.dashboard_widgets'::regclass AND NOT t.tgisinternal`,
  );
  expect(triggers.rows).toEqual([{ proname: "set_updated_at" }]);
});

test("CRUD é escopado, ordenado e faz update completo last-write-wins", async () => {
  const target = await dashboard("Widget CRUD");
  expect(
    await listDashboardWidgets(pool, { workspaceId, dashboardId: target.id }),
  ).toEqual({ outcome: "LISTED", widgets: [] });
  expect(
    await createDashboardWidget(
      pool,
      widgetInput(target.id, 0, 0, otherSemanticModelId),
    ),
  ).toEqual({ outcome: "NOT_FOUND" });
  const lower = await created(widgetInput(target.id, 5, 2));
  const upper = await created(widgetInput(target.id, 3, 0));
  const listed = await listDashboardWidgets(pool, {
    workspaceId,
    dashboardId: target.id,
  });
  expect(listed.outcome).toBe("LISTED");
  if (listed.outcome !== "LISTED") throw new Error("Expected LISTED");
  expect(listed.widgets.map((item) => item.widget.id)).toEqual([
    upper.id,
    lower.id,
  ]);
  expect(
    await getDashboardWidget(pool, {
      workspaceId: otherWorkspaceId,
      dashboardId: target.id,
      widgetId: upper.id,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  const update = await updateDashboardWidget(pool, {
    ...widgetInput(target.id, 0, 0),
    widgetId: lower.id,
    visualizationSpec: {
      version: 1,
      type: "KPI",
      value: { role: "METRIC", key: randomUUID() },
    },
  });
  expect(update).toMatchObject({
    outcome: "UPDATED",
    widget: { id: lower.id, layout: { x: 0, y: 0 } },
  });
  expect(
    await deleteDashboardWidget(pool, {
      workspaceId,
      dashboardId: target.id,
      widgetId: upper.id,
    }),
  ).toEqual({ outcome: "DELETED" });
  expect(
    await deleteDashboardWidget(pool, {
      workspaceId,
      dashboardId: target.id,
      widgetId: upper.id,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
});

test("leituras isolam JSON e relação cross-workspace quebrados por widget", async () => {
  const target = await dashboard("Broken isolation");
  const valid = await created(widgetInput(target.id, 0, 0));
  const corrupt = await created(widgetInput(target.id, 1, 0));
  const corruptSpec = await created(widgetInput(target.id, 2, 0));
  await pool.query(
    "UPDATE app.dashboard_widgets SET semantic_query='{\"version\":99}'::jsonb WHERE id=$1",
    [corrupt.id],
  );
  await pool.query(
    "UPDATE app.dashboard_widgets SET visualization_spec='{\"version\":99}'::jsonb WHERE id=$1",
    [corruptSpec.id],
  );
  const cross = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dashboard_widgets
     (dashboard_id,semantic_model_id,semantic_query,visualization_spec,layout_x,layout_y,layout_width,layout_height)
     VALUES ($1,$2,'{\"version\":1,\"metrics\":[\"00000000-0000-4000-8000-000000000001\"]}'::jsonb,
       '{\"version\":1,\"type\":\"TABLE\"}'::jsonb,3,0,1,1) RETURNING id`,
      [target.id, otherSemanticModelId],
    )
  ).rows[0];
  const listed = await listDashboardWidgets(pool, {
    workspaceId,
    dashboardId: target.id,
  });
  expect(listed.outcome).toBe("LISTED");
  if (listed.outcome !== "LISTED") throw new Error("Expected LISTED");
  expect(listed.widgets).toHaveLength(4);
  expect(
    listed.widgets.find((item) => item.widget.id === valid.id)?.configuration,
  ).toBe("VALID");
  expect(
    listed.widgets.find((item) => item.widget.id === corrupt.id),
  ).toMatchObject({
    configuration: "BROKEN",
    widget: { reason: "SEMANTIC_QUERY_INVALID" },
  });
  expect(
    listed.widgets.find((item) => item.widget.id === corruptSpec.id),
  ).toMatchObject({
    configuration: "BROKEN",
    widget: { reason: "VISUALIZATION_SPEC_INVALID" },
  });
  expect(
    listed.widgets.find((item) => item.widget.id === cross.id),
  ).toMatchObject({
    configuration: "BROKEN",
    widget: { reason: "WORKSPACE_RELATION_INVALID" },
  });
  expect(JSON.stringify(listed)).not.toContain('"version":99');

  const invalidLayout = await created(widgetInput(target.id, 4, 0));
  await pool.query(
    "ALTER TABLE app.dashboard_widgets DROP CONSTRAINT dashboard_widgets_layout_y_check",
  );
  try {
    await pool.query(
      "UPDATE app.dashboard_widgets SET layout_y=-1 WHERE id=$1",
      [invalidLayout.id],
    );
    expect(
      await getDashboardWidget(pool, {
        workspaceId,
        dashboardId: target.id,
        widgetId: invalidLayout.id,
      }),
    ).toMatchObject({
      outcome: "FOUND",
      widget: {
        configuration: "BROKEN",
        widget: { layout: null, reason: "LAYOUT_INVALID" },
      },
    });
  } finally {
    await pool.query(
      "UPDATE app.dashboard_widgets SET layout_y=0 WHERE id=$1",
      [invalidLayout.id],
    );
    await pool.query(
      "ALTER TABLE app.dashboard_widgets ADD CONSTRAINT dashboard_widgets_layout_y_check CHECK (layout_y >= 0)",
    );
  }
});

test("dois creates concorrentes na mesma posição preservam ausência de sobreposição", async () => {
  const target = await dashboard("Concurrent position");
  const results = await Promise.all([
    createDashboardWidget(pool, widgetInput(target.id, 0, 0)),
    createDashboardWidget(pool, widgetInput(target.id, 0, 0)),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "CREATED",
    "LAYOUT_CONFLICT",
  ]);
  await assertAggregateValid(target.id);
});

test("dois creates concorrentes com onze widgets admitem somente o décimo segundo", async () => {
  const target = await dashboard("Concurrent limit");
  for (let index = 0; index < 11; index += 1)
    await created(widgetInput(target.id, index, 0));
  const results = await Promise.all([
    createDashboardWidget(pool, widgetInput(target.id, 0, 1)),
    createDashboardWidget(pool, widgetInput(target.id, 1, 1)),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "CREATED",
    "LIMIT_REACHED",
  ]);
  await assertAggregateValid(target.id);
});

test("dois updates concorrentes não ocupam a mesma posição", async () => {
  const target = await dashboard("Concurrent update");
  const first = await created(widgetInput(target.id, 0, 0));
  const second = await created(widgetInput(target.id, 1, 0));
  const results = await Promise.all([
    updateDashboardWidget(pool, {
      ...widgetInput(target.id, 5, 5),
      widgetId: first.id,
    }),
    updateDashboardWidget(pool, {
      ...widgetInput(target.id, 5, 5),
      widgetId: second.id,
    }),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "LAYOUT_CONFLICT",
    "UPDATED",
  ]);
  await assertAggregateValid(target.id);
});

test("delete concorrente com movimento mantém todo estado confirmado válido", async () => {
  const target = await dashboard("Delete and move");
  const removed = await created(widgetInput(target.id, 0, 0));
  const moved = await created(widgetInput(target.id, 2, 0));
  const [deletion, movement] = await Promise.all([
    deleteDashboardWidget(pool, {
      workspaceId,
      dashboardId: target.id,
      widgetId: removed.id,
    }),
    updateDashboardWidget(pool, {
      ...widgetInput(target.id, 0, 0),
      widgetId: moved.id,
    }),
  ]);
  expect(deletion.outcome).toBe("DELETED");
  expect(["UPDATED", "LAYOUT_CONFLICT"]).toContain(movement.outcome);
  await assertAggregateValid(target.id);
});

test("delete de Dashboard serializa com create e update e CASCADE não deixa órfãos", async () => {
  const createTarget = await dashboard("Dashboard delete create");
  const createRace = await Promise.all([
    deleteDashboard(pool, { workspaceId, dashboardId: createTarget.id }),
    createDashboardWidget(pool, widgetInput(createTarget.id, 0, 0)),
  ]);
  expect(createRace[0].outcome).toBe("DELETED");
  expect(["CREATED", "NOT_FOUND"]).toContain(createRace[1].outcome);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM app.dashboard_widgets WHERE dashboard_id=$1",
        [createTarget.id],
      )
    ).rowCount,
  ).toBe(0);

  const updateTarget = await dashboard("Dashboard delete update");
  const existing = await created(widgetInput(updateTarget.id, 0, 0));
  const updateRace = await Promise.all([
    deleteDashboard(pool, { workspaceId, dashboardId: updateTarget.id }),
    updateDashboardWidget(pool, {
      ...widgetInput(updateTarget.id, 1, 0),
      widgetId: existing.id,
    }),
  ]);
  expect(updateRace[0].outcome).toBe("DELETED");
  expect(["UPDATED", "NOT_FOUND"]).toContain(updateRace[1].outcome);
  expect(
    (
      await pool.query(
        "SELECT 1 FROM app.dashboard_widgets WHERE dashboard_id=$1",
        [updateTarget.id],
      )
    ).rowCount,
  ).toBe(0);
});

test("SemanticModel referenciado é protegido por RESTRICT", async () => {
  const target = await dashboard("Model restrict");
  const existing = await created(widgetInput(target.id, 0, 0));
  const [failure, update] = await Promise.all([
    databaseFailure("DELETE FROM app.semantic_models WHERE id=$1", [
      semanticModelId,
    ]),
    updateDashboardWidget(pool, {
      ...widgetInput(target.id, 1, 0),
      widgetId: existing.id,
    }),
  ]);
  expect(failure).toMatchObject({
    code: "23001",
    constraint: "dashboard_widgets_semantic_model_fk",
  });
  expect(update.outcome).toBe("UPDATED");
  await assertAggregateValid(target.id);
});
