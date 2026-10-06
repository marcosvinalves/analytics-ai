import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), executeWidget: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock(
  "../../src/modules/dashboard/infrastructure/dashboard-widgets.ts",
  () => ({ listDashboardWidgets: mocks.list }),
);
vi.mock(
  "../../src/modules/dashboard/application/execute-dashboard-widget.ts",
  () => ({ executeDashboardWidget: mocks.executeWidget }),
);

import { executeDashboard } from "../../src/modules/dashboard/application/execute-dashboard.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const dashboardId = "10000000-0000-4000-8000-000000000002";
const modelId = "10000000-0000-4000-8000-000000000003";
const metricKey = "10000000-0000-4000-8000-000000000004";
const input = { workspaceId, dashboardId };

function id(index: number): string {
  return `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function listedWidget(index: number, y = 0, x = index) {
  return {
    configuration: "VALID" as const,
    widget: {
      id: id(index),
      dashboardId,
      semanticModelId: modelId,
      semanticQuery: { version: 1 as const, metrics: [metricKey] },
      visualizationSpec: { version: 1 as const, type: "TABLE" as const },
      layout: { x, y, width: 1, height: 1 },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  };
}

function success(widgetId: string) {
  return {
    status: "SUCCESS",
    widgetId,
    viewModel: { type: "TABLE", columns: [], rows: [] },
    explanation: { version: 1 },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets: [] });
  mocks.executeWidget.mockImplementation(
    async (_pool, value: { widgetId: string }) => success(value.widgetId),
  );
});

test("Dashboard vazio é COMPLETED sem executar Widget", async () => {
  await expect(executeDashboard({} as never, input)).resolves.toEqual({
    status: "COMPLETED",
    dashboardId,
    widgets: [],
  });
  expect(mocks.list).toHaveBeenCalledWith(expect.anything(), input);
  expect(mocks.executeWidget).not.toHaveBeenCalled();
});

test.each([
  ["NOT_FOUND", { status: "NOT_FOUND" }],
  [
    "OPERATIONAL_FAILURE",
    { status: "OPERATIONAL_FAILURE", reason: "READ_FAILED" },
  ],
  [
    "INCONSISTENT_PERSISTED_DATA",
    {
      status: "OPERATIONAL_FAILURE",
      reason: "INCONSISTENT_DASHBOARD_METADATA",
    },
  ],
])("mapeia discovery %s sem execução", async (outcome, expected) => {
  mocks.list.mockResolvedValue({ outcome });
  await expect(executeDashboard({} as never, input)).resolves.toEqual(expected);
  expect(mocks.executeWidget).not.toHaveBeenCalled();
});

test("cross-workspace permanece NOT_FOUND", async () => {
  const foreign = {
    workspaceId: "30000000-0000-4000-8000-000000000001",
    dashboardId,
  };
  mocks.list.mockResolvedValue({ outcome: "NOT_FOUND" });
  await expect(executeDashboard({} as never, foreign)).resolves.toEqual({
    status: "NOT_FOUND",
  });
  expect(mocks.list).toHaveBeenCalledWith(expect.anything(), foreign);
});

test("preserva ordem e layout iniciais apesar da ordem de conclusão", async () => {
  const widgets = [
    listedWidget(1, 0, 1),
    listedWidget(2, 1, 0),
    listedWidget(3, 1, 1),
  ];
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets });
  const gates = new Map(widgets.map((item) => [item.widget.id, deferred()]));
  mocks.executeWidget.mockImplementation(
    async (_pool, value: { widgetId: string }) => {
      await gates.get(value.widgetId)!.promise;
      return success(value.widgetId);
    },
  );

  const running = executeDashboard({} as never, input);
  await turn();
  gates.get(widgets[1].widget.id)!.resolve();
  await turn();
  gates.get(widgets[2].widget.id)!.resolve();
  gates.get(widgets[0].widget.id)!.resolve();
  const output = await running;
  expect(output).toMatchObject({ status: "COMPLETED" });
  if (output.status !== "COMPLETED") throw new Error("Expected COMPLETED");
  expect(output.widgets.map((item) => item.widgetId)).toEqual(
    widgets.map((item) => item.widget.id),
  );
  expect(output.widgets.map((item) => item.layout)).toEqual(
    widgets.map((item) => item.widget.layout),
  );
});

test("limita concorrência local a dois workers e usa os dois", async () => {
  const widgets = Array.from({ length: 5 }, (_, index) =>
    listedWidget(index + 1),
  );
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets });
  const gates = new Map(widgets.map((item) => [item.widget.id, deferred()]));
  let active = 0;
  let maximum = 0;
  const started: string[] = [];
  mocks.executeWidget.mockImplementation(
    async (_pool, value: { widgetId: string }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started.push(value.widgetId);
      await gates.get(value.widgetId)!.promise;
      active -= 1;
      return success(value.widgetId);
    },
  );

  const running = executeDashboard({} as never, input);
  await turn();
  expect(started).toHaveLength(2);
  expect(maximum).toBe(2);
  gates.get(started[0])!.resolve();
  await turn();
  expect(started).toHaveLength(3);
  for (const gate of gates.values()) gate.resolve();
  await expect(running).resolves.toMatchObject({ status: "COMPLETED" });
  expect(maximum).toBe(2);
});

test("duas invocações não compartilham limite e podem atingir quatro globalmente", async () => {
  const secondDashboard = "40000000-0000-4000-8000-000000000001";
  mocks.list.mockImplementation(
    async (_pool, value: { dashboardId: string }) => ({
      outcome: "LISTED",
      widgets: [
        listedWidget(value.dashboardId === dashboardId ? 1 : 3),
        listedWidget(value.dashboardId === dashboardId ? 2 : 4),
      ],
    }),
  );
  const gates = new Map([1, 2, 3, 4].map((index) => [id(index), deferred()]));
  let globalActive = 0;
  let globalMaximum = 0;
  mocks.executeWidget.mockImplementation(
    async (_pool, value: { widgetId: string }) => {
      globalActive += 1;
      globalMaximum = Math.max(globalMaximum, globalActive);
      await gates.get(value.widgetId)!.promise;
      globalActive -= 1;
      return success(value.widgetId);
    },
  );
  const executions = [
    executeDashboard({} as never, input),
    executeDashboard({} as never, {
      workspaceId,
      dashboardId: secondDashboard,
    }),
  ];
  await turn();
  expect(globalMaximum).toBe(4);
  for (const gate of gates.values()) gate.resolve();
  const results = await Promise.all(executions);
  expect(results.map((result) => result.status)).toEqual([
    "COMPLETED",
    "COMPLETED",
  ]);
});

test("isola todos os resultados individuais e exceção inesperada", async () => {
  const widgets = Array.from({ length: 7 }, (_, index) =>
    listedWidget(index + 1),
  );
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets });
  const individual = [
    success(id(1)),
    {
      status: "EMPTY",
      widgetId: id(2),
      viewModel: { type: "TABLE", columns: [], rows: [] },
      explanation: { version: 1 },
    },
    { status: "BROKEN", widgetId: id(3), reason: "VISUALIZATION_INCOMPATIBLE" },
    { status: "ERROR", widgetId: id(4), reason: "SOURCE_UNAVAILABLE" },
    { status: "NOT_FOUND" },
    { status: "CANCELLED", widgetId: id(6) },
  ];
  mocks.executeWidget.mockImplementation(
    async (_pool, value: { widgetId: string }) => {
      const index = widgets.findIndex(
        (item) => item.widget.id === value.widgetId,
      );
      if (index === 6) throw new Error("SQL /secret/raw.csv");
      return individual[index];
    },
  );
  const output = await executeDashboard({} as never, input);
  expect(output.status).toBe("COMPLETED");
  if (output.status !== "COMPLETED") throw new Error("Expected COMPLETED");
  expect(output.widgets.map((item) => item.result.status)).toEqual([
    "SUCCESS",
    "EMPTY",
    "BROKEN",
    "ERROR",
    "NOT_FOUND",
    "CANCELLED",
    "ERROR",
  ]);
  expect(output.widgets[6].result).toEqual({
    status: "ERROR",
    widgetId: id(7),
    reason: "OPERATIONAL_FAILURE",
  });
  expect(JSON.stringify(output)).not.toMatch(/SQL|secret|raw\.csv/);
});

test("CANCELLED individual sem abort mantém Dashboard COMPLETED", async () => {
  mocks.list.mockResolvedValue({
    outcome: "LISTED",
    widgets: [listedWidget(1)],
  });
  mocks.executeWidget.mockResolvedValue({
    status: "CANCELLED",
    widgetId: id(1),
  });
  await expect(executeDashboard({} as never, input)).resolves.toMatchObject({
    status: "COMPLETED",
    widgets: [{ result: { status: "CANCELLED" } }],
  });
});

test("cancelamento inicial não faz discovery", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeDashboard({} as never, input, { signal: controller.signal }),
  ).resolves.toEqual({
    status: "CANCELLED",
    dashboardId,
    widgets: [],
  });
  expect(mocks.list).not.toHaveBeenCalled();
});

test("abort após discovery marca todos como CANCELLED sem iniciar workers", async () => {
  const controller = new AbortController();
  const widgets = [listedWidget(1), listedWidget(2), listedWidget(3)];
  mocks.list.mockImplementation(async () => {
    controller.abort();
    return { outcome: "LISTED", widgets };
  });
  await expect(
    executeDashboard({} as never, input, { signal: controller.signal }),
  ).resolves.toEqual({
    status: "CANCELLED",
    dashboardId,
    widgets: widgets.map((item) => ({
      widgetId: item.widget.id,
      layout: item.widget.layout,
      result: { status: "CANCELLED", widgetId: item.widget.id },
    })),
  });
  expect(mocks.executeWidget).not.toHaveBeenCalled();
});

test("abort durante execução para novos Widgets e preenche CANCELLED", async () => {
  const widgets = Array.from({ length: 5 }, (_, index) =>
    listedWidget(index + 1),
  );
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets });
  const controller = new AbortController();
  const gates = new Map(
    [id(1), id(2)].map((widgetId) => [widgetId, deferred()]),
  );
  const signals: AbortSignal[] = [];
  const started: string[] = [];
  mocks.executeWidget.mockImplementation(
    async (
      _pool,
      value: { widgetId: string },
      options: { signal: AbortSignal },
    ) => {
      started.push(value.widgetId);
      signals.push(options.signal);
      await gates.get(value.widgetId)!.promise;
      return success(value.widgetId);
    },
  );
  const running = executeDashboard({} as never, input, {
    signal: controller.signal,
  });
  await turn();
  expect(started).toEqual([id(1), id(2)]);
  controller.abort();
  for (const gate of gates.values()) gate.resolve();
  const output = await running;
  expect(output.status).toBe("CANCELLED");
  if (output.status !== "CANCELLED") throw new Error("Expected CANCELLED");
  expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  expect(output.widgets.slice(0, 2).map((item) => item.result.status)).toEqual([
    "SUCCESS",
    "SUCCESS",
  ]);
  expect(output.widgets.slice(2).map((item) => item.result.status)).toEqual([
    "CANCELLED",
    "CANCELLED",
    "CANCELLED",
  ]);
});

test("usa somente IDs descobertos e não muta input", async () => {
  const widgets = [listedWidget(1), listedWidget(2)];
  mocks.list.mockResolvedValue({ outcome: "LISTED", widgets });
  const before = structuredClone(input);
  await executeDashboard({} as never, input);
  expect(input).toEqual(before);
  expect(mocks.executeWidget.mock.calls.map((call) => call[1])).toEqual(
    widgets.map((item) => ({
      workspaceId,
      dashboardId,
      widgetId: item.widget.id,
    })),
  );
});
