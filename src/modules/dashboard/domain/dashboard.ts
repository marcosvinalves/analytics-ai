export type Dashboard = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DashboardScope = {
  workspaceId: string;
  dashboardId: string;
};

export type CreateDashboardInput = {
  workspaceId: string;
  name: string;
  description?: string | null;
};

export type UpdateDashboardInput = DashboardScope & {
  name: string;
  description?: string | null;
};

export type CreateDashboardResult =
  | { outcome: "CREATED"; dashboard: Dashboard }
  | { outcome: "NOT_FOUND" }
  | { outcome: "CONFLICT"; reason: "NAME_ALREADY_EXISTS" }
  | { outcome: "OPERATIONAL_FAILURE" }
  | { outcome: "OUTCOME_UNKNOWN" };

export type ListDashboardsResult =
  | { outcome: "LISTED"; dashboards: Dashboard[] }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type GetDashboardResult =
  | { outcome: "FOUND"; dashboard: Dashboard }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type UpdateDashboardResult =
  | { outcome: "UPDATED"; dashboard: Dashboard }
  | { outcome: "NOT_FOUND" }
  | { outcome: "CONFLICT"; reason: "NAME_ALREADY_EXISTS" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type DeleteDashboardResult =
  | { outcome: "DELETED" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function invalid(): never {
  throw new TypeError("Argumentos invalidos para Dashboard.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...expected].sort().join(",")) invalid();
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    [...value].length >= 1 &&
    [...value].length <= maximum
  );
}

function validateDescription(value: unknown): void {
  if (value !== undefined && value !== null && !validText(value, 2000))
    invalid();
}

export function dashboardDescription(
  value: string | null | undefined,
): string | null {
  return value ?? null;
}

export function validateCreateDashboardInput(
  input: CreateDashboardInput,
): void {
  if (!record(input)) invalid();
  const expected = ["workspaceId", "name"];
  if ("description" in input) expected.push("description");
  exactKeys(input, expected);
  if (!validUuid(input.workspaceId) || !validText(input.name, 200)) invalid();
  validateDescription(input.description);
}

export function validateDashboardScope(input: DashboardScope): void {
  if (!record(input)) invalid();
  exactKeys(input, ["workspaceId", "dashboardId"]);
  if (!validUuid(input.workspaceId) || !validUuid(input.dashboardId)) invalid();
}

export function validateWorkspaceScope(input: { workspaceId: string }): void {
  if (!record(input)) invalid();
  exactKeys(input, ["workspaceId"]);
  if (!validUuid(input.workspaceId)) invalid();
}

export function validateUpdateDashboardInput(
  input: UpdateDashboardInput,
): void {
  if (!record(input)) invalid();
  const expected = ["workspaceId", "dashboardId", "name"];
  if ("description" in input) expected.push("description");
  exactKeys(input, expected);
  if (
    !validUuid(input.workspaceId) ||
    !validUuid(input.dashboardId) ||
    !validText(input.name, 200)
  )
    invalid();
  validateDescription(input.description);
}
