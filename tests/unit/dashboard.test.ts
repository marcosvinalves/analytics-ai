import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import {
  dashboardDescription,
  validateCreateDashboardInput,
  validateDashboardScope,
  validateUpdateDashboardInput,
  validateWorkspaceScope,
  type CreateDashboardInput,
} from "../../src/modules/dashboard/domain/dashboard.ts";
import {
  createDashboard,
  deleteDashboard,
  updateDashboard,
} from "../../src/modules/dashboard/infrastructure/dashboards.ts";

const workspaceId = "a0000000-0000-4000-8000-000000000000";
const dashboardId = "b0000000-0000-4000-8000-000000000000";
const valid: CreateDashboardInput = {
  workspaceId,
  name: "Visão de vendas",
  description: "Indicadores comerciais",
};

test("aceita contratos válidos e normaliza somente descrição ausente", () => {
  expect(() => validateCreateDashboardInput(valid)).not.toThrow();
  expect(() =>
    validateUpdateDashboardInput({ ...valid, dashboardId }),
  ).not.toThrow();
  expect(() =>
    validateDashboardScope({ workspaceId, dashboardId }),
  ).not.toThrow();
  expect(() => validateWorkspaceScope({ workspaceId })).not.toThrow();
  expect(dashboardDescription(undefined)).toBeNull();
  expect(dashboardDescription(null)).toBeNull();
  expect(dashboardDescription("Descrição")).toBe("Descrição");
});

test.each([
  { workspaceId: "invalid" },
  { name: "" },
  { name: "   " },
  { name: " Vendas" },
  { name: "Vendas " },
  { name: "x".repeat(201) },
  { description: "" },
  { description: " descrição" },
  { description: "descrição " },
  { description: "x".repeat(2001) },
])("rejeita create inválido %#", (change) => {
  expect(() => validateCreateDashboardInput({ ...valid, ...change })).toThrow(
    TypeError,
  );
});

test("conta caracteres Unicode e preserva whitespace interno", () => {
  expect(() =>
    validateCreateDashboardInput({
      workspaceId,
      name: "😀".repeat(200),
      description: "Receita  por  região",
    }),
  ).not.toThrow();
  expect(() =>
    validateCreateDashboardInput({ workspaceId, name: "😀".repeat(201) }),
  ).toThrow(TypeError);
});

test("rejeita chaves desconhecidas e escopos inválidos", () => {
  expect(() =>
    validateCreateDashboardInput({ ...valid, extra: true } as never),
  ).toThrow(TypeError);
  expect(() =>
    validateUpdateDashboardInput({ ...valid, dashboardId: "invalid" }),
  ).toThrow(TypeError);
  expect(() => validateWorkspaceScope({ workspaceId: "invalid" })).toThrow(
    TypeError,
  );
});

test("create distingue falha anterior ao envio de outcome incerto", async () => {
  const unavailable = {
    connect: vi.fn().mockRejectedValue(new Error("unavailable")),
  } as unknown as Pool;
  await expect(createDashboard(unavailable, valid)).resolves.toEqual({
    outcome: "OPERATIONAL_FAILURE",
  });

  const client = {
    query: vi.fn().mockRejectedValue(new Error("connection lost")),
    release: vi.fn(),
  } as unknown as PoolClient;
  const uncertain = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  await expect(createDashboard(uncertain, valid)).resolves.toEqual({
    outcome: "OUTCOME_UNKNOWN",
  });
  expect(client.release).toHaveBeenCalledWith(true);
});

test("update e delete convertem falhas inesperadas em OPERATIONAL_FAILURE", async () => {
  const pool = {
    query: vi.fn().mockRejectedValue(new Error("database unavailable")),
  } as unknown as Pool;
  await expect(
    updateDashboard(pool, { ...valid, dashboardId }),
  ).resolves.toEqual({ outcome: "OPERATIONAL_FAILURE" });
  await expect(
    deleteDashboard(pool, { workspaceId, dashboardId }),
  ).resolves.toEqual({ outcome: "OPERATIONAL_FAILURE" });
});
