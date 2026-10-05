import type { Pool, PoolClient } from "pg";
import {
  MAX_DASHBOARD_WIDGETS,
  prepareWidgetConfiguration,
  validateDashboardWidgetScope,
  validateDashboardWidgetsScope,
  validateSaveDashboardWidgetInput,
  validWidgetLayout,
  type CreateDashboardWidgetResult,
  type DashboardWidget,
  type DashboardWidgetRead,
  type DashboardWidgetScope,
  type DeleteDashboardWidgetResult,
  type GetDashboardWidgetResult,
  type ListDashboardWidgetsResult,
  type PreparedWidgetConfiguration,
  type SaveDashboardWidgetInput,
  type UpdateDashboardWidgetInput,
  type UpdateDashboardWidgetResult,
  type WidgetLayout,
} from "../domain/dashboard-widget.ts";
import { parseSemanticQuery } from "../../query/domain/semantic-query.ts";
import { parseVisualizationSpec } from "../domain/visualization-spec.ts";

type WidgetRow = {
  id: string;
  dashboard_id: string;
  semantic_model_id: string;
  semantic_query: unknown;
  visualization_spec: unknown;
  layout_x: number;
  layout_y: number;
  layout_width: number;
  layout_height: number;
  created_at: Date;
  updated_at: Date;
  model_workspace_id?: string | null;
};

const columns = `w.id, w.dashboard_id, w.semantic_model_id, w.semantic_query,
  w.visualization_spec, w.layout_x, w.layout_y, w.layout_width, w.layout_height,
  w.created_at, w.updated_at`;

function layout(row: WidgetRow): WidgetLayout {
  return {
    x: row.layout_x,
    y: row.layout_y,
    width: row.layout_width,
    height: row.layout_height,
  };
}

function snapshot(
  row: WidgetRow,
  config: PreparedWidgetConfiguration,
): DashboardWidget {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    semanticModelId: row.semantic_model_id,
    semanticQuery: config.semanticQuery,
    visualizationSpec: config.visualizationSpec,
    layout: config.layout,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function read(
  row: WidgetRow,
  workspaceId: string,
  dashboardId: string,
): DashboardWidgetRead | null {
  if (
    typeof row.id !== "string" ||
    typeof row.dashboard_id !== "string" ||
    typeof row.semantic_model_id !== "string" ||
    row.dashboard_id !== dashboardId ||
    !(row.created_at instanceof Date) ||
    !(row.updated_at instanceof Date) ||
    Number.isNaN(row.created_at.getTime()) ||
    Number.isNaN(row.updated_at.getTime())
  )
    return null;
  const candidateLayout = layout(row);
  const broken = (
    reason:
      | "SEMANTIC_QUERY_INVALID"
      | "VISUALIZATION_SPEC_INVALID"
      | "LAYOUT_INVALID"
      | "WORKSPACE_RELATION_INVALID",
  ): DashboardWidgetRead => ({
    configuration: "BROKEN",
    widget: {
      id: row.id,
      dashboardId: row.dashboard_id,
      semanticModelId: row.semantic_model_id,
      layout: validWidgetLayout(candidateLayout) ? candidateLayout : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      reason,
    },
  });
  if (row.model_workspace_id !== workspaceId)
    return broken("WORKSPACE_RELATION_INVALID");
  if (!validWidgetLayout(candidateLayout)) return broken("LAYOUT_INVALID");
  const query = parseSemanticQuery(row.semantic_query);
  if (!query.valid) return broken("SEMANTIC_QUERY_INVALID");
  const spec = parseVisualizationSpec(row.visualization_spec);
  if (!spec.valid) return broken("VISUALIZATION_SPEC_INVALID");
  return {
    configuration: "VALID",
    widget: snapshot(row, {
      semanticQuery: query.query,
      semanticQueryJson: query.canonicalJson,
      visualizationSpec: spec.spec,
      visualizationSpecJson: spec.canonicalJson,
      layout: candidateLayout,
    }),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* original outcome wins */
  }
}

async function lockDashboard(
  client: PoolClient,
  workspaceId: string,
  dashboardId: string,
): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        "SELECT id FROM app.dashboards WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [dashboardId, workspaceId],
      )
    ).rows[0],
  );
}

async function modelInWorkspace(
  client: PoolClient,
  workspaceId: string,
  semanticModelId: string,
): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        `SELECT m.id FROM app.semantic_models m
     JOIN app.datasets d ON d.id=m.dataset_id
     WHERE m.id=$1 AND d.workspace_id=$2 FOR KEY SHARE OF m`,
        [semanticModelId, workspaceId],
      )
    ).rows[0],
  );
}

async function hasOverlap(
  client: PoolClient,
  dashboardId: string,
  value: WidgetLayout,
  exceptId?: string,
): Promise<boolean> {
  return Boolean(
    (
      await client.query(
        `SELECT 1 FROM app.dashboard_widgets
     WHERE dashboard_id=$1 AND ($6::uuid IS NULL OR id<>$6)
       AND layout_x < $2::integer + $4::integer
       AND layout_x + layout_width > $2::integer
       AND layout_y < $3::integer + $5::integer
       AND layout_y + layout_height > $3::integer
     LIMIT 1`,
        [
          dashboardId,
          value.x,
          value.y,
          value.width,
          value.height,
          exceptId ?? null,
        ],
      )
    ).rows[0],
  );
}

/** Internal metadata operation. Workspace scope is not authentication. */
export async function createDashboardWidget(
  pool: Pool,
  input: SaveDashboardWidgetInput,
): Promise<CreateDashboardWidgetResult> {
  validateSaveDashboardWidgetInput(input, false);
  const prepared = prepareWidgetConfiguration(input);
  if (!prepared.valid)
    return { outcome: "INVALID_CONFIGURATION", reason: prepared.reason };
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    if (
      !(await lockDashboard(client, input.workspaceId, input.dashboardId)) ||
      !(await modelInWorkspace(
        client,
        input.workspaceId,
        input.semanticModelId,
      ))
    ) {
      await rollback(client);
      return { outcome: "NOT_FOUND" };
    }
    const count = Number(
      (
        await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM app.dashboard_widgets WHERE dashboard_id=$1",
          [input.dashboardId],
        )
      ).rows[0].count,
    );
    if (count >= MAX_DASHBOARD_WIDGETS) {
      await rollback(client);
      return { outcome: "LIMIT_REACHED" };
    }
    if (await hasOverlap(client, input.dashboardId, prepared.value.layout)) {
      await rollback(client);
      return { outcome: "LAYOUT_CONFLICT" };
    }
    const row = (
      await client.query<WidgetRow>(
        `INSERT INTO app.dashboard_widgets
       (dashboard_id, semantic_model_id, semantic_query, visualization_spec, layout_x, layout_y, layout_width, layout_height)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8)
       RETURNING id, dashboard_id, semantic_model_id, semantic_query, visualization_spec,
         layout_x, layout_y, layout_width, layout_height, created_at, updated_at`,
        [
          input.dashboardId,
          input.semanticModelId,
          prepared.value.semanticQueryJson,
          prepared.value.visualizationSpecJson,
          prepared.value.layout.x,
          prepared.value.layout.y,
          prepared.value.layout.width,
          prepared.value.layout.height,
        ],
      )
    ).rows[0];
    commitAttempted = true;
    await client.query("COMMIT");
    return { outcome: "CREATED", widget: snapshot(row, prepared.value) };
  } catch {
    if (!commitAttempted) await rollback(client);
    return commitAttempted
      ? { outcome: "OUTCOME_UNKNOWN" }
      : { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}

export async function updateDashboardWidget(
  pool: Pool,
  input: UpdateDashboardWidgetInput,
): Promise<UpdateDashboardWidgetResult> {
  validateSaveDashboardWidgetInput(input, true);
  const prepared = prepareWidgetConfiguration(input);
  if (!prepared.valid)
    return { outcome: "INVALID_CONFIGURATION", reason: prepared.reason };
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
  try {
    await client.query("BEGIN");
    if (
      !(await lockDashboard(client, input.workspaceId, input.dashboardId)) ||
      !(await modelInWorkspace(
        client,
        input.workspaceId,
        input.semanticModelId,
      ))
    ) {
      await rollback(client);
      return { outcome: "NOT_FOUND" };
    }
    const exists = (
      await client.query(
        "SELECT 1 FROM app.dashboard_widgets WHERE id=$1 AND dashboard_id=$2",
        [input.widgetId, input.dashboardId],
      )
    ).rows[0];
    if (!exists) {
      await rollback(client);
      return { outcome: "NOT_FOUND" };
    }
    if (
      await hasOverlap(
        client,
        input.dashboardId,
        prepared.value.layout,
        input.widgetId,
      )
    ) {
      await rollback(client);
      return { outcome: "LAYOUT_CONFLICT" };
    }
    const row = (
      await client.query<WidgetRow>(
        `UPDATE app.dashboard_widgets SET semantic_model_id=$3, semantic_query=$4::jsonb,
       visualization_spec=$5::jsonb, layout_x=$6, layout_y=$7, layout_width=$8, layout_height=$9
       WHERE id=$1 AND dashboard_id=$2 RETURNING id, dashboard_id, semantic_model_id,
       semantic_query, visualization_spec, layout_x, layout_y, layout_width, layout_height, created_at, updated_at`,
        [
          input.widgetId,
          input.dashboardId,
          input.semanticModelId,
          prepared.value.semanticQueryJson,
          prepared.value.visualizationSpecJson,
          prepared.value.layout.x,
          prepared.value.layout.y,
          prepared.value.layout.width,
          prepared.value.layout.height,
        ],
      )
    ).rows[0];
    await client.query("COMMIT");
    return { outcome: "UPDATED", widget: snapshot(row, prepared.value) };
  } catch {
    await rollback(client);
    return { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}

export async function deleteDashboardWidget(
  pool: Pool,
  input: DashboardWidgetScope,
): Promise<DeleteDashboardWidgetResult> {
  validateDashboardWidgetScope(input);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
  try {
    await client.query("BEGIN");
    if (!(await lockDashboard(client, input.workspaceId, input.dashboardId))) {
      await rollback(client);
      return { outcome: "NOT_FOUND" };
    }
    const result = await client.query(
      "DELETE FROM app.dashboard_widgets WHERE id=$1 AND dashboard_id=$2",
      [input.widgetId, input.dashboardId],
    );
    await client.query("COMMIT");
    return result.rowCount ? { outcome: "DELETED" } : { outcome: "NOT_FOUND" };
  } catch {
    await rollback(client);
    return { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}

export async function getDashboardWidget(
  pool: Pool,
  input: DashboardWidgetScope,
): Promise<GetDashboardWidgetResult> {
  validateDashboardWidgetScope(input);
  try {
    const row = (
      await pool.query<WidgetRow>(
        `SELECT ${columns}, ds.workspace_id AS model_workspace_id
       FROM app.dashboard_widgets w JOIN app.dashboards d ON d.id=w.dashboard_id
       LEFT JOIN app.semantic_models m ON m.id=w.semantic_model_id
       LEFT JOIN app.datasets ds ON ds.id=m.dataset_id
       WHERE w.id=$1 AND w.dashboard_id=$2 AND d.workspace_id=$3`,
        [input.widgetId, input.dashboardId, input.workspaceId],
      )
    ).rows[0];
    if (!row) return { outcome: "NOT_FOUND" };
    const widget = read(row, input.workspaceId, input.dashboardId);
    return widget
      ? { outcome: "FOUND", widget }
      : { outcome: "INCONSISTENT_PERSISTED_DATA" };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}

export async function listDashboardWidgets(
  pool: Pool,
  input: { workspaceId: string; dashboardId: string },
): Promise<ListDashboardWidgetsResult> {
  validateDashboardWidgetsScope(input);
  try {
    const rows = (
      await pool.query<WidgetRow & { widget_id: string | null }>(
        `SELECT w.id AS widget_id, ${columns}, ds.workspace_id AS model_workspace_id
       FROM app.dashboards d LEFT JOIN app.dashboard_widgets w ON w.dashboard_id=d.id
       LEFT JOIN app.semantic_models m ON m.id=w.semantic_model_id
       LEFT JOIN app.datasets ds ON ds.id=m.dataset_id
       WHERE d.id=$1 AND d.workspace_id=$2
       ORDER BY w.layout_y NULLS LAST, w.layout_x NULLS LAST, w.id NULLS LAST`,
        [input.dashboardId, input.workspaceId],
      )
    ).rows;
    if (!rows[0]) return { outcome: "NOT_FOUND" };
    const widgets: DashboardWidgetRead[] = [];
    for (const row of rows) {
      if (row.widget_id === null) continue;
      const widget = read(row, input.workspaceId, input.dashboardId);
      if (!widget) return { outcome: "INCONSISTENT_PERSISTED_DATA" };
      widgets.push(widget);
    }
    return { outcome: "LISTED", widgets };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}
