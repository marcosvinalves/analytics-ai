import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  create: vi.fn(),
  headers: vi.fn(),
  query: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/db", () => ({
  getMetadataPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/local-upload-context", () => ({
  localUploadContext: mocks.context,
}));
vi.mock("@/modules/dataset/domain/dataset-detail", () => ({
  validId: (value: string) =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),
}));
vi.mock(
  "@/modules/semantic/domain/governed-metric-template",
  async () =>
    import("../../src/modules/semantic/domain/governed-metric-template.ts"),
);
vi.mock(
  "@/modules/semantic/domain/semantic-metric-review",
  async () =>
    import("../../src/modules/semantic/domain/semantic-metric-review.ts"),
);
vi.mock(
  "@/modules/semantic/infrastructure/read-semantic-metric-review",
  () => ({
    readSemanticMetricReview: mocks.read,
  }),
);
vi.mock("@/modules/semantic/infrastructure/metrics", () => ({
  createMetric: mocks.create,
  updateMetric: mocks.update,
  removeMetric: mocks.remove,
}));

import {
  createSemanticMetricAction,
  removeSemanticMetricAction,
  updateSemanticMetricAction,
  type SemanticMetricActionState,
} from "../../src/app/data/datasets/[datasetId]/semantic/metric-actions.ts";

const datasetId = "10000000-0000-4000-8000-000000000035";
const columnId = "20000000-0000-4000-8000-000000000035";
const fieldKey = "30000000-0000-4000-8000-000000000035";
const revisionId = "40000000-0000-4000-8000-000000000035";
const workspaceId = "50000000-0000-4000-8000-000000000035";
const metricKey = "60000000-0000-4000-8000-000000000035";
const metricId = "70000000-0000-4000-8000-000000000035";
const initial: SemanticMetricActionState = { outcome: "IDLE" };

function review(withMetric = false) {
  return {
    outcome: "EDITABLE",
    review: {
      dataset: { id: datasetId, name: "Vendas" },
      revision: { id: revisionId, revisionNumber: 1, status: "DRAFT" },
      datasetVersion: {
        id: "80000000-0000-4000-8000-000000000035",
        versionNumber: 1,
        status: "READY",
      },
      fields: [
        {
          datasetColumnId: columnId,
          fieldKey,
          name: "quantity",
          label: "Quantidade",
          semanticType: { kind: "INTEGER" },
          ordinalPosition: 1,
        },
      ],
      metrics: withMetric
        ? [
            {
              metricKey,
              name: "total_quantity",
              label: "Quantidade total",
              description: null,
              resultType: { kind: "INTEGER" },
              dependencies: [
                {
                  datasetColumnId: columnId,
                  fieldKey,
                  name: "quantity",
                  label: "Quantidade",
                  semanticType: { kind: "INTEGER" },
                  ordinalPosition: 1,
                },
              ],
              classification: {
                kind: "SUPPORTED",
                template: "SUM_FIELD",
                firstFieldKey: fieldKey,
                secondFieldKey: null,
              },
            },
          ]
        : [],
    },
  };
}

function form(update = false, overrides: Record<string, string> = {}) {
  const values = {
    ...(update ? { metricKey } : {}),
    datasetId,
    template: "SUM_FIELD",
    firstDatasetColumnId: columnId,
    secondDatasetColumnId: "",
    name: "total_quantity",
    label: "Quantidade total",
    description: "",
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({
    workspaceId,
    origin: "http://127.0.0.1:3018",
  });
  mocks.headers.mockResolvedValue(
    new Headers({ origin: "http://127.0.0.1:3018", host: "127.0.0.1:3018" }),
  );
  mocks.read.mockResolvedValue(review());
  mocks.create.mockResolvedValue({ outcome: "CREATED" });
  mocks.update.mockResolvedValue({ outcome: "UPDATED" });
  mocks.remove.mockResolvedValue({ outcome: "REMOVED" });
  mocks.query.mockResolvedValue({ rows: [{ id: metricId }] });
});

test("rejeita FormData inexato, IDs inválidos e origem divergente", async () => {
  expect(
    (await createSemanticMetricAction(initial, form(false, { extra: "x" })))
      .outcome,
  ).toBe("INVALID_INPUT");
  expect(
    (await createSemanticMetricAction(initial, form(false, { datasetId: "x" })))
      .outcome,
  ).toBe("INVALID_INPUT");
  mocks.headers.mockResolvedValueOnce(
    new Headers({ origin: "http://localhost:3018", host: "127.0.0.1:3018" }),
  );
  expect((await createSemanticMetricAction(initial, form())).outcome).toBe(
    "INVALID_INPUT",
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

test("resolve field no servidor e envia somente AST construído ao writer", async () => {
  expect(await createSemanticMetricAction(initial, form())).toMatchObject({
    outcome: "SAVED",
    operation: "CREATED",
  });
  expect(mocks.create).toHaveBeenCalledWith(expect.anything(), {
    workspaceId,
    semanticModelRevisionId: revisionId,
    name: "total_quantity",
    label: "Quantidade total",
    description: null,
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey },
    },
  });
});

test("create concorrente só reconcilia configuração integralmente equivalente", async () => {
  mocks.create.mockResolvedValue({
    outcome: "CONFLICT",
    reason: "NAME_ALREADY_EXISTS",
  });
  mocks.read
    .mockResolvedValueOnce(review())
    .mockResolvedValueOnce(review(true));
  expect(await createSemanticMetricAction(initial, form())).toMatchObject({
    outcome: "SAVED",
    operation: "UNCHANGED",
  });
  const different = review(true);
  different.review.metrics[0].label = "Outro label";
  mocks.read.mockReset();
  mocks.read.mockResolvedValueOnce(review()).mockResolvedValueOnce(different);
  expect((await createSemanticMetricAction(initial, form())).outcome).toBe(
    "CONFLICT",
  );
});

test("update usa metricKey apenas para localizar e preserva identidade", async () => {
  mocks.read.mockResolvedValue(review(true));
  expect(await updateSemanticMetricAction(initial, form(true))).toMatchObject({
    outcome: "SAVED",
    operation: "UPDATED",
  });
  expect(mocks.update).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ metricId, semanticModelRevisionId: revisionId }),
  );
});

test("remove exige confirmação e falhas permanecem seguras", async () => {
  const data = new FormData();
  data.append("datasetId", datasetId);
  data.append("metricKey", metricKey);
  expect((await removeSemanticMetricAction(initial, data)).outcome).toBe(
    "NOT_FOUND",
  );
  data.append("confirmRemoval", "true");
  mocks.read.mockResolvedValue(review(true));
  expect(await removeSemanticMetricAction(initial, data)).toMatchObject({
    outcome: "REMOVED",
  });
  mocks.create.mockRejectedValueOnce(new Error("password=secret"));
  expect(await createSemanticMetricAction(initial, form())).toMatchObject({
    outcome: "OPERATIONAL_FAILURE",
    code: "WRITE_FAILED",
  });
  mocks.create.mockRejectedValueOnce(new Error("METRIC_OUTCOME_UNKNOWN"));
  expect(await createSemanticMetricAction(initial, form())).toMatchObject({
    outcome: "OPERATIONAL_FAILURE",
    code: "OUTCOME_UNKNOWN",
  });
});
