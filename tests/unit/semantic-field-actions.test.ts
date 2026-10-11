import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  create: vi.fn(),
  headers: vi.fn(),
  pool: {},
  read: vi.fn(),
  remove: vi.fn(),
  revalidate: vi.fn(),
  update: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/db", () => ({ getMetadataPool: () => mocks.pool }));
vi.mock("@/lib/local-upload-context", () => ({
  localUploadContext: mocks.context,
}));
vi.mock("@/modules/dataset/domain/dataset-detail", () => ({
  validId: (value: string) =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),
}));
vi.mock(
  "@/modules/semantic/domain/semantic-field-review",
  async () =>
    import("../../src/modules/semantic/domain/semantic-field-review.ts"),
);
vi.mock("@/modules/semantic/infrastructure/read-semantic-field-review", () => ({
  readSemanticFieldReview: mocks.read,
}));
vi.mock("@/modules/semantic/infrastructure/semantic-fields", () => ({
  createSemanticField: mocks.create,
  updateSemanticField: mocks.update,
  removeSemanticField: mocks.remove,
}));

import {
  createSemanticFieldAction,
  removeSemanticFieldAction,
  updateSemanticFieldAction,
  type SemanticFieldActionState,
} from "../../src/app/data/datasets/[datasetId]/semantic/field-actions.ts";

const datasetId = "10000000-0000-4000-8000-000000000034";
const columnId = "20000000-0000-4000-8000-000000000034";
const revisionId = "30000000-0000-4000-8000-000000000034";
const workspaceId = "40000000-0000-4000-8000-000000000034";
const initial: SemanticFieldActionState = { outcome: "IDLE" };
const field = {
  id: "50000000-0000-4000-8000-000000000034",
  fieldKey: "60000000-0000-4000-8000-000000000034",
  name: "quantity",
  label: "Quantidade",
  description: null,
  semanticType: { kind: "INTEGER" },
  compatibility: { compatibility: "SAFE", reason: "DIRECT" },
  referencedByMetric: false,
} as const;

function review(currentField: typeof field | null = null) {
  return {
    outcome: "EDITABLE",
    review: {
      dataset: { id: datasetId, name: "Vendas" },
      revision: { id: revisionId, revisionNumber: 1, status: "DRAFT" },
      datasetVersion: {
        id: "70000000-0000-4000-8000-000000000034",
        versionNumber: 1,
        status: "READY",
      },
      columns: [
        {
          datasetColumnId: columnId,
          physicalName: "quantity",
          physicalType: "BIGINT",
          ordinalPosition: 1,
          nullable: null,
          nullCount: "0",
          proposedSemanticType: { kind: "INTEGER" },
          field: currentField,
        },
      ],
    },
  };
}

function editForm(overrides: Record<string, string> = {}) {
  const values = {
    datasetId,
    datasetColumnId: columnId,
    name: "quantity",
    label: "Quantidade",
    description: "",
    semanticType: "INTEGER",
    decimalPrecision: "",
    decimalScale: "",
    acceptExplicitConversion: "false",
    ...overrides,
  };
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
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
});

test("rejeita FormData inexato, UUID inválido e origem divergente", async () => {
  expect(
    (await createSemanticFieldAction(initial, editForm({ extra: "x" })))
      .outcome,
  ).toBe("NOT_FOUND");
  expect(
    (await createSemanticFieldAction(initial, editForm({ datasetId: "x" })))
      .outcome,
  ).toBe("NOT_FOUND");
  mocks.headers.mockResolvedValueOnce(
    new Headers({ origin: "http://localhost:3018", host: "127.0.0.1:3018" }),
  );
  expect((await createSemanticFieldAction(initial, editForm())).outcome).toBe(
    "NOT_FOUND",
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

test("resolve workspace, revisão e coluna no servidor antes de criar", async () => {
  const result = await createSemanticFieldAction(initial, editForm());
  expect(result).toMatchObject({ outcome: "SAVED", operation: "CREATED" });
  expect(mocks.read).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    datasetId,
  });
  expect(mocks.create).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    semanticModelRevisionId: revisionId,
    datasetColumnId: columnId,
    name: "quantity",
    label: "Quantidade",
    description: null,
    semanticType: { kind: "INTEGER" },
    acceptExplicitConversion: false,
  });
  expect(mocks.revalidate).toHaveBeenCalledWith(
    `/data/datasets/${datasetId}/semantic`,
  );
});

test("reconcilia create concorrente igual sem duplicar", async () => {
  mocks.create.mockResolvedValueOnce({ outcome: "CONFLICT" });
  mocks.read
    .mockResolvedValueOnce(review())
    .mockResolvedValueOnce(review(field));
  expect(await createSemanticFieldAction(initial, editForm())).toMatchObject({
    outcome: "SAVED",
    operation: "UNCHANGED",
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

test("update preserva a identidade resolvida e mapeia conflito seguro", async () => {
  mocks.read.mockResolvedValue(review(field));
  expect(
    await updateSemanticFieldAction(initial, editForm({ label: "Qtd." })),
  ).toMatchObject({ outcome: "SAVED", operation: "UPDATED" });
  expect(mocks.update).toHaveBeenCalledWith(
    mocks.pool,
    expect.objectContaining({
      workspaceId,
      semanticModelRevisionId: revisionId,
      semanticFieldId: field.id,
      changes: expect.objectContaining({ label: "Qtd." }),
    }),
  );
  mocks.update.mockResolvedValueOnce({
    outcome: "FIELD_CHANGE_INVALIDATES_METRIC",
  });
  expect((await updateSemanticFieldAction(initial, editForm())).outcome).toBe(
    "FIELD_CHANGE_INVALIDATES_METRIC",
  );
});

test("remove exige confirmação e respeita FIELD_IN_USE", async () => {
  const missing = new FormData();
  missing.append("datasetId", datasetId);
  missing.append("datasetColumnId", columnId);
  expect((await removeSemanticFieldAction(initial, missing)).outcome).toBe(
    "NOT_FOUND",
  );

  const confirmed = missing;
  confirmed.append("confirmRemoval", "true");
  mocks.read.mockResolvedValue(review(field));
  mocks.remove.mockResolvedValueOnce({ outcome: "FIELD_IN_USE" });
  expect((await removeSemanticFieldAction(initial, confirmed)).outcome).toBe(
    "FIELD_IN_USE",
  );
});

test("falhas inesperadas e commit incerto não vazam detalhes nem repetem writer", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.create.mockRejectedValueOnce(new Error("password=secret"));
  expect(await createSemanticFieldAction(initial, editForm())).toMatchObject({
    outcome: "OPERATIONAL_FAILURE",
    code: "WRITE_FAILED",
  });
  mocks.create.mockRejectedValueOnce(
    new Error("SEMANTIC_FIELD_OUTCOME_UNKNOWN"),
  );
  expect(await createSemanticFieldAction(initial, editForm())).toMatchObject({
    outcome: "OPERATIONAL_FAILURE",
    code: "OUTCOME_UNKNOWN",
  });
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
