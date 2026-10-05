import type { Pool, PoolClient } from "pg";
import {
  dashboardDescription,
  validateCreateDashboardInput,
  validateDashboardScope,
  validateUpdateDashboardInput,
  validateWorkspaceScope,
  type CreateDashboardInput,
  type CreateDashboardResult,
  type Dashboard,
  type DashboardScope,
  type DeleteDashboardResult,
  type GetDashboardResult,
  type ListDashboardsResult,
  type UpdateDashboardInput,
  type UpdateDashboardResult,
} from "../domain/dashboard.ts";

type DashboardRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};

type DatabaseError = { code?: unknown; constraint?: unknown };

const columns = "id, workspace_id, name, description, created_at, updated_at";

function snapshot(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function databaseError(error: unknown): DatabaseError {
  return error && typeof error === "object" ? (error as DatabaseError) : {};
}

async function connection(pool: Pool): Promise<PoolClient | undefined> {
  try {
    return await pool.connect();
  } catch {
    return undefined;
  }
}

/** Internal metadata operation. Workspace scope is not authentication. */
export async function createDashboard(
  pool: Pool,
  input: CreateDashboardInput,
): Promise<CreateDashboardResult> {
  validateCreateDashboardInput(input);
  const client = await connection(pool);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  let discard = false;
  try {
    const result = await client.query<DashboardRow>(
      `INSERT INTO app.dashboards (workspace_id, name, description)
       SELECT id, $2, $3 FROM app.workspaces WHERE id = $1
       RETURNING ${columns}`,
      [input.workspaceId, input.name, dashboardDescription(input.description)],
    );
    const row = result.rows[0];
    return row
      ? { outcome: "CREATED", dashboard: snapshot(row) }
      : { outcome: "NOT_FOUND" };
  } catch (error) {
    const db = databaseError(error);
    if (
      db.code === "23505" &&
      db.constraint === "dashboards_workspace_name_unique"
    )
      return { outcome: "CONFLICT", reason: "NAME_ALREADY_EXISTS" };
    if (db.code === "23503" && db.constraint === "dashboards_workspace_fk")
      return { outcome: "NOT_FOUND" };
    discard = true;
    return { outcome: "OUTCOME_UNKNOWN" };
  } finally {
    client.release(discard);
  }
}

export async function listDashboards(
  pool: Pool,
  input: { workspaceId: string },
): Promise<ListDashboardsResult> {
  validateWorkspaceScope(input);
  try {
    const result = await pool.query<
      DashboardRow & { dashboard_id: string | null }
    >(
      `SELECT d.id AS dashboard_id, d.id, d.workspace_id, d.name, d.description,
              d.created_at, d.updated_at
       FROM app.workspaces w
       LEFT JOIN app.dashboards d ON d.workspace_id = w.id
       WHERE w.id = $1
       ORDER BY d.name ASC`,
      [input.workspaceId],
    );
    if (!result.rows[0]) return { outcome: "NOT_FOUND" };
    return {
      outcome: "LISTED",
      dashboards: result.rows
        .filter((row) => row.dashboard_id !== null)
        .map(snapshot),
    };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}

export async function getDashboard(
  pool: Pool,
  input: DashboardScope,
): Promise<GetDashboardResult> {
  validateDashboardScope(input);
  try {
    const row = (
      await pool.query<DashboardRow>(
        `SELECT ${columns} FROM app.dashboards
         WHERE id = $1 AND workspace_id = $2`,
        [input.dashboardId, input.workspaceId],
      )
    ).rows[0];
    return row
      ? { outcome: "FOUND", dashboard: snapshot(row) }
      : { outcome: "NOT_FOUND" };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}

export async function updateDashboard(
  pool: Pool,
  input: UpdateDashboardInput,
): Promise<UpdateDashboardResult> {
  validateUpdateDashboardInput(input);
  try {
    const row = (
      await pool.query<DashboardRow>(
        `UPDATE app.dashboards
         SET name = $3, description = $4
         WHERE id = $1 AND workspace_id = $2
         RETURNING ${columns}`,
        [
          input.dashboardId,
          input.workspaceId,
          input.name,
          dashboardDescription(input.description),
        ],
      )
    ).rows[0];
    return row
      ? { outcome: "UPDATED", dashboard: snapshot(row) }
      : { outcome: "NOT_FOUND" };
  } catch (error) {
    const db = databaseError(error);
    if (
      db.code === "23505" &&
      db.constraint === "dashboards_workspace_name_unique"
    )
      return { outcome: "CONFLICT", reason: "NAME_ALREADY_EXISTS" };
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}

export async function deleteDashboard(
  pool: Pool,
  input: DashboardScope,
): Promise<DeleteDashboardResult> {
  validateDashboardScope(input);
  try {
    const result = await pool.query(
      `DELETE FROM app.dashboards
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [input.dashboardId, input.workspaceId],
    );
    return result.rowCount ? { outcome: "DELETED" } : { outcome: "NOT_FOUND" };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}
