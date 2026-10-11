import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  create: vi.fn(),
  headers: vi.fn(),
  pool: {},
  readiness: vi.fn(),
  redirect: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({ getMetadataPool: () => mocks.pool }));
vi.mock("@/lib/local-upload-context", () => ({
  localUploadContext: mocks.context,
}));
vi.mock("@/modules/dataset/domain/dataset-detail", () => ({
  validId: (value: string) =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),
}));
vi.mock("@/modules/semantic/domain/semantic-onboarding", () => ({
  initialSemanticModelName: (datasetId: string) =>
    `dataset_${datasetId.replaceAll("-", "").toLowerCase()}`,
}));
vi.mock("@/modules/semantic/infrastructure/read-semantic-onboarding", () => ({
  readSemanticOnboardingReadiness: mocks.readiness,
}));
vi.mock(
  "@/modules/semantic/infrastructure/create-semantic-model-draft",
  () => ({ createSemanticModelDraft: mocks.create }),
);

import {
  createSemanticDraftAction,
  type CreateSemanticDraftActionState,
} from "../../src/app/data/datasets/[datasetId]/semantic/actions.ts";

const datasetId = "10000000-0000-4000-8000-000000000033";
const versionId = "20000000-0000-4000-8000-000000000033";
const workspaceId = "30000000-0000-4000-8000-000000000033";
const initial: CreateSemanticDraftActionState = { outcome: "IDLE" };

function form(entries?: [string, string][]) {
  const data = new FormData();
  for (const [key, value] of entries ?? [
    ["datasetId", datasetId],
    ["datasetVersionId", versionId],
  ])
    data.append(key, value);
  return data;
}

const dataset = {
  id: datasetId,
  name: "Vendas",
  selectedVersion: { id: versionId, versionNumber: 1, status: "READY" },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({
    workspaceId,
    origin: "http://127.0.0.1:3018",
  });
  mocks.headers.mockResolvedValue(
    new Headers({ origin: "http://127.0.0.1:3018", host: "127.0.0.1:3018" }),
  );
  mocks.readiness.mockResolvedValue({ outcome: "CAN_CREATE_DRAFT", dataset });
  mocks.create.mockResolvedValue({ outcome: "CREATED" });
  mocks.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

test.each<{ entries: [string, string][] }>([
  { entries: [["datasetId", datasetId]] },
  {
    entries: [
      ["datasetId", datasetId],
      ["datasetVersionId", versionId],
      ["workspaceId", workspaceId],
    ],
  },
  {
    entries: [
      ["datasetId", "invalid"],
      ["datasetVersionId", versionId],
    ],
  },
])("rejeita FormData fora do contrato", async ({ entries }) => {
  await expect(
    createSemanticDraftAction(initial, form(entries)),
  ).resolves.toEqual({
    outcome: "NOT_FOUND",
    message: "Dataset não encontrado.",
  });
  expect(mocks.readiness).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

test("revalida contexto e origem", async () => {
  mocks.context.mockReturnValueOnce(null);
  expect((await createSemanticDraftAction(initial, form())).outcome).toBe(
    "NOT_FOUND",
  );
  mocks.headers.mockResolvedValueOnce(
    new Headers({ origin: "http://localhost:3018", host: "127.0.0.1:3018" }),
  );
  expect((await createSemanticDraftAction(initial, form())).outcome).toBe(
    "NOT_FOUND",
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

test("cria com identidade técnica server-controlled e redireciona", async () => {
  await expect(createSemanticDraftAction(initial, form())).rejects.toThrow(
    "NEXT_REDIRECT",
  );
  expect(mocks.readiness).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
  });
  expect(mocks.create).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
    modelName: "dataset_10000000000040008000000000000033",
    label: "Vendas",
    description: null,
  });
  expect(mocks.redirect).toHaveBeenCalledWith(
    `/data/datasets/${datasetId}/semantic?version=${versionId}`,
  );
});

test("draft existente é retomado sem chamar writer", async () => {
  mocks.readiness.mockResolvedValueOnce({
    outcome: "DRAFT_AVAILABLE",
    dataset,
    model: { id: "40000000-0000-4000-8000-000000000033", name: "sales" },
    draft: {
      id: "50000000-0000-4000-8000-000000000033",
      revisionNumber: 1,
      status: "DRAFT",
      label: "Vendas",
      datasetVersion: { id: versionId, versionNumber: 1 },
    },
    published: null,
  });
  await expect(createSemanticDraftAction(initial, form())).rejects.toThrow(
    "NEXT_REDIRECT",
  );
  expect(mocks.create).not.toHaveBeenCalled();
});

test.each([
  [{ outcome: "NOT_FOUND" }, "NOT_FOUND"],
  [
    { outcome: "DATASET_NOT_READY", dataset, status: "PROCESSING" },
    "DATASET_NOT_READY",
  ],
  [{ outcome: "BROKEN", dataset, message: "safe" }, "BROKEN"],
  [
    {
      outcome: "PUBLISHED_ONLY",
      dataset,
      model: { id: "40000000-0000-4000-8000-000000000033", name: "sales" },
      published: {},
    },
    "CONFLICT",
  ],
  [{ outcome: "OPERATIONAL_FAILURE" }, "OPERATIONAL_FAILURE"],
] as const)(
  "mapeia readiness %# sem executar writer",
  async (readiness, outcome) => {
    mocks.readiness.mockResolvedValueOnce(readiness);
    expect((await createSemanticDraftAction(initial, form())).outcome).toBe(
      outcome,
    );
    expect(mocks.create).not.toHaveBeenCalled();
  },
);

test("exceção e commit incerto retornam erro seguro sem retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.create.mockRejectedValueOnce(
    new Error("SEMANTIC_DRAFT_OUTCOME_UNKNOWN password=secret"),
  );
  const result = await createSemanticDraftAction(initial, form());
  expect(result).toEqual({
    outcome: "OPERATIONAL_FAILURE",
    message:
      "Não foi possível confirmar a preparação. Atualize a página antes de tentar novamente.",
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
