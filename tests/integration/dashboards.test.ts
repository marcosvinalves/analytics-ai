import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
} from "../../src/modules/dashboard/infrastructure/dashboards.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let organizationId: string;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Dashboard tests') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string; name: string }>(
    `INSERT INTO app.workspaces(organization_id, name)
     VALUES ($1, 'Dashboard A'), ($1, 'Dashboard B') RETURNING id, name`,
    [organizationId],
  );
  workspaceId = workspaces.rows.find((row) => row.name === "Dashboard A")!.id;
  otherWorkspaceId = workspaces.rows.find(
    (row) => row.name === "Dashboard B",
  )!.id;
});

afterAll(async () => {
  if (!pool) return;
  await pool.end();
  await resetTestDatabase();
});

async function created(name: string, targetWorkspaceId = workspaceId) {
  const result = await createDashboard(pool, {
    workspaceId: targetWorkspaceId,
    name,
    description: `${name} description`,
  });
  if (result.outcome !== "CREATED")
    throw new Error(`Expected CREATED, got ${result.outcome}`);
  return result.dashboard;
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

test("catálogo contém somente a fundação aprovada de Dashboard", async () => {
  const columns = await pool.query(
    `SELECT column_name, data_type, character_maximum_length, is_nullable,
            column_default
     FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'dashboards'
     ORDER BY ordinal_position`,
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    "id",
    "workspace_id",
    "name",
    "description",
    "created_at",
    "updated_at",
  ]);
  expect(columns.rows.find((row) => row.column_name === "name")).toMatchObject({
    data_type: "character varying",
    character_maximum_length: 200,
    is_nullable: "NO",
  });
  expect(
    columns.rows.find((row) => row.column_name === "description"),
  ).toMatchObject({
    data_type: "character varying",
    character_maximum_length: 2000,
    is_nullable: "YES",
  });

  const constraints = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE conrelid = 'app.dashboards'::regclass AND contype <> 'n'
     ORDER BY conname`,
  );
  expect(constraints.rows.map((row) => row.conname)).toEqual([
    "dashboards_description_nonempty",
    "dashboards_name_nonempty",
    "dashboards_pkey",
    "dashboards_workspace_fk",
    "dashboards_workspace_name_unique",
  ]);
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'app' AND tablename = 'dashboards' ORDER BY indexname`,
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "dashboards_pkey",
    "dashboards_workspace_name_unique",
  ]);
  const triggers = await pool.query<{ proname: string }>(
    `SELECT p.proname FROM pg_trigger t
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'app.dashboards'::regclass AND NOT t.tgisinternal`,
  );
  expect(triggers.rows).toEqual([{ proname: "set_updated_at" }]);
});

test("CRUD distingue lista vazia, workspace ausente e mantém ordem", async () => {
  expect(await listDashboards(pool, { workspaceId })).toEqual({
    outcome: "LISTED",
    dashboards: [],
  });
  expect(await listDashboards(pool, { workspaceId: randomUUID() })).toEqual({
    outcome: "NOT_FOUND",
  });
  expect(
    await createDashboard(pool, {
      workspaceId: randomUUID(),
      name: "Missing workspace",
    }),
  ).toEqual({ outcome: "NOT_FOUND" });

  const zeta = await created("Zeta");
  const alpha = await created("Alpha");
  const listed = await listDashboards(pool, { workspaceId });
  expect(listed.outcome).toBe("LISTED");
  if (listed.outcome !== "LISTED") throw new Error("Expected LISTED");
  expect(listed.dashboards.map((dashboard) => dashboard.id)).toEqual([
    alpha.id,
    zeta.id,
  ]);

  expect(
    await getDashboard(pool, { workspaceId, dashboardId: alpha.id }),
  ).toEqual({
    outcome: "FOUND",
    dashboard: alpha,
  });
  const updated = await updateDashboard(pool, {
    workspaceId,
    dashboardId: alpha.id,
    name: "Beta",
    description: null,
  });
  expect(updated).toMatchObject({
    outcome: "UPDATED",
    dashboard: { name: "Beta", description: null, createdAt: alpha.createdAt },
  });
  if (updated.outcome !== "UPDATED") throw new Error("Expected UPDATED");
  expect(updated.dashboard.updatedAt.getTime()).toBeGreaterThanOrEqual(
    alpha.updatedAt.getTime(),
  );
  expect(
    await deleteDashboard(pool, { workspaceId, dashboardId: alpha.id }),
  ).toEqual({
    outcome: "DELETED",
  });
  expect(
    await deleteDashboard(pool, { workspaceId, dashboardId: alpha.id }),
  ).toEqual({
    outcome: "NOT_FOUND",
  });
});

test("unicidade é case-sensitive e create concorrente tem um vencedor", async () => {
  const first = await created("Case Name");
  const caseVariant = await created("case name");
  expect(caseVariant.id).not.toBe(first.id);
  expect(
    await createDashboard(pool, { workspaceId, name: "Case Name" }),
  ).toEqual({ outcome: "CONFLICT", reason: "NAME_ALREADY_EXISTS" });
  expect(
    await updateDashboard(pool, {
      workspaceId,
      dashboardId: caseVariant.id,
      name: "Case Name",
      description: null,
    }),
  ).toEqual({ outcome: "CONFLICT", reason: "NAME_ALREADY_EXISTS" });
  await expect(
    createDashboard(pool, { workspaceId: otherWorkspaceId, name: "Case Name" }),
  ).resolves.toMatchObject({ outcome: "CREATED" });

  const attempts = await Promise.all([
    createDashboard(pool, { workspaceId, name: "Concurrent" }),
    createDashboard(pool, { workspaceId, name: "Concurrent" }),
  ]);
  expect(attempts.map((result) => result.outcome).sort()).toEqual([
    "CONFLICT",
    "CREATED",
  ]);
  expect(
    (
      await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM app.dashboards WHERE workspace_id=$1 AND name='Concurrent'",
        [workspaceId],
      )
    ).rows[0].count,
  ).toBe(1);
});

test("workspace isolation oculta dashboard de outro workspace", async () => {
  const dashboard = await created("Isolated");
  const scope = { workspaceId: otherWorkspaceId, dashboardId: dashboard.id };
  expect(await getDashboard(pool, scope)).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await updateDashboard(pool, {
      ...scope,
      name: "Compromised",
      description: null,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  expect(await deleteDashboard(pool, scope)).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await getDashboard(pool, { workspaceId, dashboardId: dashboard.id }),
  ).toMatchObject({
    outcome: "FOUND",
    dashboard: { name: "Isolated" },
  });
});

test("constraints rejeitam whitespace e preservam nomes case-sensitive", async () => {
  for (const [column, value, constraint] of [
    ["name", " Bad", "dashboards_name_nonempty"],
    ["name", "Bad ", "dashboards_name_nonempty"],
    ["description", " ", "dashboards_description_nonempty"],
  ] as const) {
    if (column === "name") {
      const actual = await databaseFailure(
        "INSERT INTO app.dashboards(workspace_id,name) VALUES ($1,$2)",
        [workspaceId, value],
      );
      expect(actual).toMatchObject({ code: "23514", constraint });
    } else {
      const actual = await databaseFailure(
        "INSERT INTO app.dashboards(workspace_id,name,description) VALUES ($1,$2,$3)",
        [workspaceId, `Description ${randomUUID()}`, value],
      );
      expect(actual).toMatchObject({ code: "23514", constraint });
    }
  }
});

test("FK rejeita pai inexistente e RESTRICT protege Workspace", async () => {
  const missing = await databaseFailure(
    "INSERT INTO app.dashboards(workspace_id,name) VALUES ($1,'Missing')",
    [randomUUID()],
  );
  expect(missing).toMatchObject({
    code: "23503",
    constraint: "dashboards_workspace_fk",
  });

  await created("Protected");
  for (const statement of [
    "DELETE FROM app.workspaces WHERE id=$1",
    "UPDATE app.workspaces SET id=gen_random_uuid() WHERE id=$1",
  ]) {
    const restricted = await databaseFailure(statement, [workspaceId]);
    expect(restricted).toMatchObject({
      code: "23001",
      constraint: "dashboards_workspace_fk",
    });
  }
});

test("UPDATE aceito usa last-write-wins e mantém timestamps do Alpha", async () => {
  const dashboard = await created("Last Write");
  const first = await updateDashboard(pool, {
    workspaceId,
    dashboardId: dashboard.id,
    name: "First Write",
    description: "first",
  });
  const second = await updateDashboard(pool, {
    workspaceId,
    dashboardId: dashboard.id,
    name: "Second Write",
    description: "second",
  });
  expect(first.outcome).toBe("UPDATED");
  expect(second).toMatchObject({
    outcome: "UPDATED",
    dashboard: { name: "Second Write", description: "second" },
  });
  if (second.outcome !== "UPDATED") throw new Error("Expected UPDATED");
  const repeated = await updateDashboard(pool, {
    workspaceId,
    dashboardId: dashboard.id,
    name: "Second Write",
    description: "second",
  });
  expect(repeated.outcome).toBe("UPDATED");
  if (repeated.outcome !== "UPDATED") throw new Error("Expected UPDATED");
  expect(repeated.dashboard.createdAt).toEqual(dashboard.createdAt);
  expect(repeated.dashboard.updatedAt.getTime()).toBeGreaterThanOrEqual(
    second.dashboard.updatedAt.getTime(),
  );
});
