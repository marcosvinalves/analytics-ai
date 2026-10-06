import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWidget: vi.fn(),
  runQuery: vi.fn(),
  map: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock(
  "../../src/modules/dashboard/infrastructure/dashboard-widgets.ts",
  () => ({ getDashboardWidget: mocks.getWidget }),
);
vi.mock("../../src/modules/query/application/run-semantic-query.ts", () => ({
  runSemanticQuery: mocks.runQuery,
}));
vi.mock("../../src/modules/dashboard/domain/visualization-mapping.ts", () => ({
  mapVisualization: mocks.map,
}));

import { executeDashboardWidget } from "../../src/modules/dashboard/application/execute-dashboard-widget.ts";

const ids = {
  workspace: "10000000-0000-4000-8000-000000000001",
  dashboard: "10000000-0000-4000-8000-000000000002",
  widget: "10000000-0000-4000-8000-000000000003",
  model: "10000000-0000-4000-8000-000000000004",
  metric: "10000000-0000-4000-8000-000000000005",
};

const scope = {
  workspaceId: ids.workspace,
  dashboardId: ids.dashboard,
  widgetId: ids.widget,
};
const query = { version: 1, metrics: [ids.metric] } as const;
const spec = {
  version: 1,
  type: "KPI",
  value: { role: "METRIC", key: ids.metric },
} as const;
const widget = {
  id: ids.widget,
  dashboardId: ids.dashboard,
  semanticModelId: ids.model,
  semanticQuery: query,
  visualizationSpec: spec,
  layout: { x: 0, y: 0, width: 1, height: 1 },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const result = {
  columns: [
    {
      key: ids.metric,
      label: "Revenue",
      role: "METRIC",
      semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
    },
  ],
  rows: [[{ type: "DECIMAL", value: "2059.61" }]],
};
const explanation = {
  version: 1,
  orderBy: [],
  marker: "preserved",
};
const kpi = {
  type: "KPI",
  metric: result.columns[0],
  state: "VALUE",
  value: {
    type: "DECIMAL",
    value: "2059.61",
    exactness: "EXACT",
    geometryValue: 2059.61,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getWidget.mockResolvedValue({
    outcome: "FOUND",
    widget: { configuration: "VALID", widget },
  });
  mocks.runQuery.mockResolvedValue({
    outcome: "SUCCESS",
    execution: { result, explanation },
  });
  mocks.map.mockReturnValue({ outcome: "MAPPED", viewModel: kpi });
});

test("usa exclusivamente identidade e configuração persistidas", async () => {
  const controller = new AbortController();
  const output = await executeDashboardWidget({} as never, scope, {
    signal: controller.signal,
  });
  expect(mocks.getWidget).toHaveBeenCalledWith(expect.anything(), scope);
  expect(mocks.runQuery).toHaveBeenCalledTimes(1);
  expect(mocks.runQuery).toHaveBeenCalledWith(
    expect.anything(),
    {
      workspaceId: ids.workspace,
      semanticModelId: ids.model,
      query,
    },
    { signal: controller.signal },
  );
  expect(mocks.map).toHaveBeenCalledWith(spec, result, explanation.orderBy);
  expect(output).toEqual({
    status: "SUCCESS",
    widgetId: ids.widget,
    viewModel: kpi,
    explanation,
  });
  expect(output).not.toHaveProperty("result");
  expect(output).not.toHaveProperty("query");
});

test("preserva DECIMAL exato e a mesma QueryExplanation", async () => {
  const output = await executeDashboardWidget({} as never, scope);
  expect(output).toMatchObject({
    status: "SUCCESS",
    viewModel: {
      value: { type: "DECIMAL", value: "2059.61", exactness: "EXACT" },
    },
  });
  if (output.status !== "SUCCESS") throw new Error("Expected SUCCESS");
  expect(output.explanation).toBe(explanation);
});

test.each([
  {
    type: "TABLE",
    columns: result.columns,
    rows: result.rows,
  },
  {
    type: "BAR",
    category: { ...result.columns[0], role: "DIMENSION" },
    value: result.columns[0],
    points: [
      {
        category: { type: "STRING", value: "São Paulo" },
        value: { ...kpi.value },
      },
    ],
  },
  {
    type: "LINE",
    x: {
      ...result.columns[0],
      role: "DIMENSION",
      semanticType: { kind: "DATE" },
    },
    y: result.columns[0],
    points: [
      {
        x: { type: "DATE", value: "2026-10-05" },
        y: { ...kpi.value },
      },
    ],
  },
])("retorna SUCCESS para ViewModel $type não vazio", async (viewModel) => {
  mocks.map.mockReturnValue({ outcome: "MAPPED", viewModel });
  await expect(
    executeDashboardWidget({} as never, scope),
  ).resolves.toMatchObject({
    status: "SUCCESS",
    widgetId: ids.widget,
    viewModel,
    explanation,
  });
});

test("cancelamento inicial evita até a leitura", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeDashboardWidget({} as never, scope, { signal: controller.signal }),
  ).resolves.toEqual({ status: "CANCELLED", widgetId: ids.widget });
  expect(mocks.getWidget).not.toHaveBeenCalled();
  expect(mocks.runQuery).not.toHaveBeenCalled();
});

test("cancelamento após leitura evita Query Foundation", async () => {
  const controller = new AbortController();
  mocks.getWidget.mockImplementation(async () => {
    controller.abort();
    return { outcome: "FOUND", widget: { configuration: "VALID", widget } };
  });
  await expect(
    executeDashboardWidget({} as never, scope, { signal: controller.signal }),
  ).resolves.toEqual({ status: "CANCELLED", widgetId: ids.widget });
  expect(mocks.runQuery).not.toHaveBeenCalled();
});

test.each([
  "SEMANTIC_QUERY_INVALID",
  "VISUALIZATION_SPEC_INVALID",
  "LAYOUT_INVALID",
  "WORKSPACE_RELATION_INVALID",
] as const)("Widget BROKEN %s não executa", async (reason) => {
  mocks.getWidget.mockResolvedValue({
    outcome: "FOUND",
    widget: {
      configuration: "BROKEN",
      widget: { ...widget, layout: null, reason },
    },
  });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual({
    status: "BROKEN",
    widgetId: ids.widget,
    reason,
  });
  expect(mocks.runQuery).not.toHaveBeenCalled();
});

test.each([
  ["NOT_FOUND", { status: "NOT_FOUND" }],
  [
    "INCONSISTENT_PERSISTED_DATA",
    {
      status: "ERROR",
      widgetId: ids.widget,
      reason: "INCONSISTENT_WIDGET_METADATA",
    },
  ],
  [
    "OPERATIONAL_FAILURE",
    {
      status: "ERROR",
      widgetId: ids.widget,
      reason: "OPERATIONAL_FAILURE",
    },
  ],
])("mapeia leitura %s sem executar", async (outcome, expected) => {
  mocks.getWidget.mockResolvedValue({ outcome });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual(
    expected,
  );
  expect(mocks.runQuery).not.toHaveBeenCalled();
});

test("cross-workspace é NOT_FOUND e não executa", async () => {
  mocks.getWidget.mockResolvedValue({ outcome: "NOT_FOUND" });
  const foreign = {
    ...scope,
    workspaceId: "20000000-0000-4000-8000-000000000001",
  };
  await expect(executeDashboardWidget({} as never, foreign)).resolves.toEqual({
    status: "NOT_FOUND",
  });
  expect(mocks.getWidget).toHaveBeenCalledWith(expect.anything(), foreign);
  expect(mocks.runQuery).not.toHaveBeenCalled();
});

test.each([
  ["INVALID_QUERY", "INCONSISTENT_QUERY_PIPELINE"],
  ["MODEL_NOT_FOUND", "INCONSISTENT_QUERY_PIPELINE"],
  ["MODEL_NOT_PUBLISHED", "MODEL_NOT_PUBLISHED"],
  ["QUERY_NOT_SUPPORTED", "QUERY_NOT_SUPPORTED"],
  ["SOURCE_UNAVAILABLE", "SOURCE_UNAVAILABLE"],
  ["SOURCE_INCONSISTENT", "SOURCE_INCONSISTENT"],
  ["QUERY_EXECUTION_FAILED", "QUERY_EXECUTION_FAILED"],
  ["QUERY_TIMEOUT", "QUERY_TIMEOUT"],
  ["RESULT_LIMIT_EXCEEDED", "RESULT_LIMIT_EXCEEDED"],
  ["RESULT_TOO_LARGE", "RESULT_TOO_LARGE"],
  ["INCONSISTENT_QUERY_PIPELINE", "INCONSISTENT_QUERY_PIPELINE"],
  ["OPERATIONAL_FAILURE", "OPERATIONAL_FAILURE"],
])("mapeia Query Foundation %s para ERROR/%s", async (outcome, reason) => {
  mocks.runQuery.mockResolvedValue({ outcome, message: "safe" });
  const output = await executeDashboardWidget({} as never, scope);
  expect(output).toEqual({ status: "ERROR", widgetId: ids.widget, reason });
  if (outcome === "QUERY_NOT_SUPPORTED")
    expect(output.status).not.toBe("BROKEN");
  expect(mocks.map).not.toHaveBeenCalled();
});

test("preserva DATA_NOT_READY seguro", async () => {
  mocks.runQuery.mockResolvedValue({
    outcome: "DATA_NOT_READY",
    message: "safe",
    status: "PROCESSING",
  });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual({
    status: "ERROR",
    widgetId: ids.widget,
    reason: "DATA_NOT_READY",
    dataStatus: "PROCESSING",
  });
});

test("QUERY_CANCELLED e exceção com signal abortado são CANCELLED", async () => {
  mocks.runQuery.mockResolvedValue({
    outcome: "QUERY_CANCELLED",
    message: "safe",
  });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual({
    status: "CANCELLED",
    widgetId: ids.widget,
  });

  const controller = new AbortController();
  mocks.runQuery.mockImplementation(async () => {
    controller.abort();
    throw new Error("internal");
  });
  await expect(
    executeDashboardWidget({} as never, scope, { signal: controller.signal }),
  ).resolves.toEqual({ status: "CANCELLED", widgetId: ids.widget });
});

test.each([
  [{ type: "KPI", state: "EMPTY", metric: result.columns[0] }, "EMPTY"],
  [{ type: "TABLE", columns: result.columns, rows: [] }, "EMPTY"],
  [
    {
      type: "BAR",
      category: result.columns[0],
      value: result.columns[0],
      points: [],
    },
    "EMPTY",
  ],
  [
    { type: "LINE", x: result.columns[0], y: result.columns[0], points: [] },
    "EMPTY",
  ],
  [
    {
      type: "KPI",
      state: "VALUE",
      metric: result.columns[0],
      value: { type: "NULL" },
    },
    "SUCCESS",
  ],
])("classifica ViewModel %# como %s", async (viewModel, status) => {
  mocks.map.mockReturnValue({ outcome: "MAPPED", viewModel });
  await expect(
    executeDashboardWidget({} as never, scope),
  ).resolves.toMatchObject({
    status,
    widgetId: ids.widget,
    viewModel,
    explanation,
  });
});

test("INCOMPATIBLE é BROKEN e INVALID_RESULT é inconsistência interna", async () => {
  mocks.map.mockReturnValueOnce({
    outcome: "INCOMPATIBLE",
    issues: [{ path: "$", code: "OUTPUT_NOT_FOUND", message: "safe" }],
  });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual({
    status: "BROKEN",
    widgetId: ids.widget,
    reason: "VISUALIZATION_INCOMPATIBLE",
  });
  mocks.map.mockReturnValueOnce({
    outcome: "INVALID_RESULT",
    reason: "ROW_WIDTH_MISMATCH",
  });
  await expect(executeDashboardWidget({} as never, scope)).resolves.toEqual({
    status: "ERROR",
    widgetId: ids.widget,
    reason: "INCONSISTENT_QUERY_PIPELINE",
  });
});

test("falhas inesperadas são seguras e inputs não são alterados", async () => {
  const before = structuredClone(scope);
  mocks.runQuery.mockRejectedValueOnce(new Error("SQL secret /raw/path"));
  const operational = await executeDashboardWidget({} as never, scope);
  expect(operational).toEqual({
    status: "ERROR",
    widgetId: ids.widget,
    reason: "OPERATIONAL_FAILURE",
  });
  mocks.map.mockImplementationOnce(() => {
    throw new Error("DuckDB internal");
  });
  const inconsistent = await executeDashboardWidget({} as never, scope);
  expect(inconsistent).toEqual({
    status: "ERROR",
    widgetId: ids.widget,
    reason: "INCONSISTENT_QUERY_PIPELINE",
  });
  expect(scope).toEqual(before);
  expect(JSON.stringify([operational, inconsistent])).not.toMatch(
    /SQL|raw|DuckDB/,
  );
});
