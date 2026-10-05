import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  resolveSource: vi.fn(),
  resolveQuery: vi.fn(),
  plan: vi.fn(),
  compile: vi.fn(),
  execute: vi.fn(),
  explain: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock(
  "../../src/modules/semantic/infrastructure/semantic-inspection.ts",
  () => ({ inspectPublishedSemanticModel: mocks.inspect }),
);
vi.mock(
  "../../src/modules/dataset/application/resolve-analytical-source.ts",
  () => ({ resolveAnalyticalSource: mocks.resolveSource }),
);
vi.mock("../../src/modules/query/domain/resolve-semantic-query.ts", () => ({
  resolveSemanticQuery: mocks.resolveQuery,
}));
vi.mock("../../src/modules/query/domain/plan-physical-query.ts", () => ({
  planPhysicalQuery: mocks.plan,
}));
vi.mock(
  "../../src/modules/query/infrastructure/duckdb-query-compiler.ts",
  () => ({ compilePhysicalQuery: mocks.compile }),
);
vi.mock(
  "../../src/modules/query/application/execute-compiled-query.ts",
  () => ({ executeCompiledQuery: mocks.execute }),
);
vi.mock("../../src/modules/query/domain/build-query-explanation.ts", () => ({
  buildQueryExplanation: mocks.explain,
}));

import { runSemanticQuery } from "../../src/modules/query/application/run-semantic-query.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const modelId = "10000000-0000-4000-8000-000000000002";
const metricKey = "10000000-0000-4000-8000-000000000003";
const datasetId = "10000000-0000-4000-8000-000000000004";
const datasetVersionId = "10000000-0000-4000-8000-000000000005";
const query = { version: 1, metrics: [metricKey] };
const inspection = {
  model: { id: modelId, name: "sales" },
  revision: {
    id: "10000000-0000-4000-8000-000000000006",
    revisionNumber: 1,
    status: "PUBLISHED",
    label: "Sales",
    description: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    publishedAt: new Date("2026-01-01T00:00:00Z"),
  },
  dataset: { id: datasetId, name: "Sales" },
  datasetVersion: { id: datasetVersionId, versionNumber: 1, status: "READY" },
  fields: [],
  metrics: [],
};
const resolvedQuery = {
  model: { id: modelId },
  dataset: { id: datasetId },
  datasetVersion: { id: datasetVersionId },
};
const source = { token: "source" };
const plan = { token: "plan" };
const compiledQuery = { token: "compiled" };
const result = { columns: [], rows: [] };
const explanation = { version: 1 };

function input() {
  return { workspaceId, semanticModelId: modelId, query };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue({ outcome: "SUCCESS", inspection });
  mocks.resolveQuery.mockReturnValue({
    outcome: "RESOLVED",
    query: resolvedQuery,
  });
  mocks.resolveSource.mockResolvedValue({ outcome: "RESOLVED", source });
  mocks.plan.mockReturnValue({ outcome: "PLANNED", plan });
  mocks.compile.mockReturnValue({ outcome: "COMPILED", compiledQuery });
  mocks.execute.mockResolvedValue({ outcome: "SUCCESS", result });
  mocks.explain.mockReturnValue({ outcome: "EXPLAINED", explanation });
});

test("orquestra os contratos existentes e preserva a cadeia causal", async () => {
  const controller = new AbortController();
  await expect(
    runSemanticQuery({} as never, input(), { signal: controller.signal }),
  ).resolves.toEqual({
    outcome: "SUCCESS",
    execution: { result, explanation },
  });
  expect(mocks.inspect).toHaveBeenCalledWith(expect.anything(), {
    workspaceId,
    semanticModelId: modelId,
  });
  expect(mocks.resolveSource).toHaveBeenCalledWith(expect.anything(), {
    workspaceId,
    datasetId,
    datasetVersionId,
  });
  expect(mocks.plan).toHaveBeenCalledWith(resolvedQuery, source);
  expect(mocks.execute).toHaveBeenCalledWith(compiledQuery, {
    signal: controller.signal,
  });
  expect(mocks.explain).toHaveBeenCalledWith({ resolvedQuery, result });
});

test("input invalido para no parser sem I/O ou resultado parcial", async () => {
  const output = await runSemanticQuery({} as never, {
    ...input(),
    query: { version: 1, metrics: [], sql: "select secret" },
  });
  expect(output).toMatchObject({ outcome: "INVALID_QUERY" });
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.resolveSource).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(output)).not.toContain("select secret");
});

test("cancelamento anterior para antes do pipeline", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runSemanticQuery({} as never, input(), { signal: controller.signal }),
  ).resolves.toMatchObject({ outcome: "QUERY_CANCELLED" });
  expect(mocks.inspect).not.toHaveBeenCalled();
});

test("cancelamento observado apos I/O nao inicia DuckDB", async () => {
  const controller = new AbortController();
  mocks.resolveSource.mockImplementation(async () => {
    controller.abort();
    return { outcome: "RESOLVED", source };
  });
  await expect(
    runSemanticQuery({} as never, input(), { signal: controller.signal }),
  ).resolves.toMatchObject({ outcome: "QUERY_CANCELLED" });
  expect(mocks.execute).not.toHaveBeenCalled();
});

test.each([
  [{ outcome: "NOT_FOUND" }, "MODEL_NOT_FOUND"],
  [{ outcome: "NO_PUBLISHED_REVISION" }, "MODEL_NOT_PUBLISHED"],
  [
    {
      outcome: "INCONSISTENT_SNAPSHOT",
      semanticModelRevisionId: inspection.revision.id,
      status: "PUBLISHED",
      issues: [],
    },
    "INCONSISTENT_QUERY_PIPELINE",
  ],
  [{ outcome: "OPERATIONAL_FAILURE" }, "OPERATIONAL_FAILURE"],
] as const)("mapeia inspection %#", async (value, expected) => {
  mocks.inspect.mockResolvedValue(value);
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.resolveSource).not.toHaveBeenCalled();
});

test("input de scope invalido permanece indistinguivel de model ausente", async () => {
  mocks.inspect.mockRejectedValue(new TypeError("internal validation"));
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: "MODEL_NOT_FOUND",
  });
});

test.each([
  [
    { outcome: "REVISION_NOT_PUBLISHED", status: "ARCHIVED" },
    "INCONSISTENT_QUERY_PIPELINE",
  ],
  [{ outcome: "INVALID_SEMANTIC_QUERY", issues: [] }, "QUERY_NOT_SUPPORTED"],
] as const)("mapeia semantic resolution %#", async (value, expected) => {
  mocks.resolveQuery.mockReturnValue(value);
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.resolveSource).not.toHaveBeenCalled();
});

test.each([
  [{ outcome: "NOT_FOUND" }, "INCONSISTENT_QUERY_PIPELINE"],
  [{ outcome: "UNSUPPORTED_SOURCE_TYPE" }, "QUERY_NOT_SUPPORTED"],
  [{ outcome: "SOURCE_UNAVAILABLE" }, "SOURCE_UNAVAILABLE"],
  [{ outcome: "SOURCE_INTEGRITY_FAILED" }, "SOURCE_INCONSISTENT"],
  [{ outcome: "OPERATIONAL_FAILURE" }, "OPERATIONAL_FAILURE"],
] as const)("mapeia source resolution %#", async (value, expected) => {
  mocks.resolveSource.mockResolvedValue(value);
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("preserva DATA_NOT_READY quando os snapshots concordam", async () => {
  mocks.inspect.mockResolvedValue({
    outcome: "SUCCESS",
    inspection: {
      ...inspection,
      datasetVersion: { ...inspection.datasetVersion, status: "PROCESSING" },
    },
  });
  mocks.resolveSource.mockResolvedValue({
    outcome: "NOT_READY",
    status: "PROCESSING",
  });
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: "DATA_NOT_READY",
    status: "PROCESSING",
  });
});

test("status de source que contradiz inspection e inconsistencia do pipeline", async () => {
  mocks.resolveSource.mockResolvedValue({
    outcome: "NOT_READY",
    status: "FAILED",
  });
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: "INCONSISTENT_QUERY_PIPELINE",
  });
});

test.each([
  [{ outcome: "SOURCE_MISMATCH" }, "INCONSISTENT_QUERY_PIPELINE"],
  [{ outcome: "UNSUPPORTED_SOURCE_TYPE" }, "QUERY_NOT_SUPPORTED"],
  [
    { outcome: "UNSUPPORTED_PHYSICAL_CONVERSION", fieldKey: metricKey },
    "QUERY_NOT_SUPPORTED",
  ],
  [
    { outcome: "INCONSISTENT_RESOLVED_QUERY", path: "$.metrics" },
    "INCONSISTENT_QUERY_PIPELINE",
  ],
] as const)("mapeia planner %#", async (value, expected) => {
  mocks.plan.mockReturnValue(value);
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.execute).not.toHaveBeenCalled();
});

test.each([
  [
    { outcome: "INCONSISTENT_PHYSICAL_PLAN", path: "$" },
    "INCONSISTENT_QUERY_PIPELINE",
  ],
  [
    { outcome: "UNSUPPORTED_COMPILATION", feature: "internal" },
    "QUERY_NOT_SUPPORTED",
  ],
] as const)("mapeia compiler %#", async (value, expected) => {
  mocks.compile.mockReturnValue(value);
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.execute).not.toHaveBeenCalled();
});

test.each([
  ["SOURCE_SCHEMA_MISMATCH", "SOURCE_INCONSISTENT"],
  ["SOURCE_VALUE_INVALID", "SOURCE_INCONSISTENT"],
  ["SOURCE_INTEGRITY_FAILED", "SOURCE_INCONSISTENT"],
  ["NUMERIC_OVERFLOW", "QUERY_EXECUTION_FAILED"],
  ["RESULT_LIMIT_EXCEEDED", "RESULT_LIMIT_EXCEEDED"],
  ["RESULT_SIZE_LIMIT_EXCEEDED", "RESULT_TOO_LARGE"],
  ["QUERY_TIMEOUT", "QUERY_TIMEOUT"],
  ["QUERY_CANCELLED", "QUERY_CANCELLED"],
  ["INCONSISTENT_COMPILED_QUERY", "INCONSISTENT_QUERY_PIPELINE"],
  ["INCONSISTENT_QUERY_RESULT", "INCONSISTENT_QUERY_PIPELINE"],
  ["QUERY_OPERATIONAL_FAILURE", "OPERATIONAL_FAILURE"],
] as const)("mapeia executor %s", async (value, expected) => {
  mocks.execute.mockResolvedValue({ outcome: value });
  await expect(runSemanticQuery({} as never, input())).resolves.toMatchObject({
    outcome: expected,
  });
  expect(mocks.explain).not.toHaveBeenCalled();
});

test("nao retorna resultado parcial se explanation detectar inconsistencia", async () => {
  mocks.explain.mockReturnValue({
    outcome: "INCONSISTENT_QUERY_ARTIFACTS",
    issues: [],
  });
  const output = await runSemanticQuery({} as never, input());
  expect(output).toMatchObject({ outcome: "INCONSISTENT_QUERY_PIPELINE" });
  expect(output).not.toHaveProperty("execution");
});

test("erros publicos nao carregam detalhes internos", async () => {
  mocks.execute.mockResolvedValue({ outcome: "QUERY_OPERATIONAL_FAILURE" });
  const output = await runSemanticQuery({} as never, input());
  const serialized = JSON.stringify(output);
  for (const forbidden of [
    "SELECT",
    "raw.csv",
    "storage_key",
    "physicalName",
    "__t018_source",
    "DuckDB",
    "stack",
  ])
    expect(serialized).not.toContain(forbidden);
});
