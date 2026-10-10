import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  headers: vi.fn(),
  metadata: vi.fn(),
  pool: {},
  process: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/db", () => ({ getMetadataPool: () => mocks.pool }));
vi.mock("@/lib/local-upload-context", () => ({
  localUploadContext: mocks.context,
}));
vi.mock("@/modules/dataset/infrastructure/read-dataset-metadata", () => ({
  readDatasetMetadata: mocks.metadata,
}));
vi.mock("@/modules/dataset/application/process-dataset-version", () => ({
  processDatasetVersion: mocks.process,
}));
vi.mock("@/modules/dataset/domain/dataset-detail", () => ({
  validId: (value: string) =>
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),
}));

import {
  processDatasetAction,
  type ProcessDatasetActionState,
} from "../../src/app/data/datasets/[datasetId]/actions.ts";

const datasetId = "10000000-0000-4000-8000-000000000032";
const versionId = "20000000-0000-4000-8000-000000000032";
const workspaceId = "30000000-0000-4000-8000-000000000032";
const initial: ProcessDatasetActionState = { outcome: "IDLE" };

function form(entries: [string, string][] = []) {
  const data = new FormData();
  for (const [key, value] of entries.length
    ? entries
    : [
        ["datasetId", datasetId],
        ["datasetVersionId", versionId],
      ])
    data.append(key, value);
  return data;
}

function detail(status: "PROCESSING" | "READY" | "FAILED" = "PROCESSING") {
  return {
    detail: {
      dataset: { id: datasetId },
      version: { id: versionId, status },
    },
  };
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
  mocks.metadata.mockResolvedValue(detail());
  mocks.process.mockResolvedValue({
    outcome: "TRANSITIONED",
    version: { status: "READY" },
  });
});

test.each([
  { entries: [["datasetId", datasetId]] },
  {
    entries: [
      ["datasetId", datasetId],
      ["datasetId", datasetId],
      ["datasetVersionId", versionId],
    ],
  },
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
] as { entries: [string, string][] }[])(
  "rejeita FormData fora do contrato",
  async ({ entries }) => {
    await expect(processDatasetAction(initial, form(entries))).resolves.toEqual(
      {
        outcome: "NOT_FOUND",
        message: "Dataset não encontrado.",
      },
    );
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  },
);

test("revalida contexto e origem dentro da action", async () => {
  mocks.context.mockReturnValueOnce(null);
  expect((await processDatasetAction(initial, form())).outcome).toBe(
    "NOT_FOUND",
  );
  mocks.headers.mockResolvedValueOnce(
    new Headers({ origin: "http://localhost:3018", host: "127.0.0.1:3018" }),
  );
  expect((await processDatasetAction(initial, form())).outcome).toBe(
    "NOT_FOUND",
  );
  expect(mocks.process).not.toHaveBeenCalled();
});

test("confirma workspace/dataset/versão e não processa escopo alheio", async () => {
  mocks.metadata.mockResolvedValueOnce(null);
  expect((await processDatasetAction(initial, form())).outcome).toBe(
    "NOT_FOUND",
  );
  expect(mocks.metadata).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    datasetId,
    versionId,
  });
  expect(mocks.process).not.toHaveBeenCalled();
});

test.each(["READY", "FAILED"] as const)(
  "não chama pipeline para %s",
  async (status) => {
    mocks.metadata.mockResolvedValueOnce(detail(status));
    const result = await processDatasetAction(initial, form());
    expect(result).toMatchObject({ outcome: "ALREADY_TERMINAL", status });
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.revalidate).toHaveBeenCalledWith(
      `/data/datasets/${datasetId}`,
    );
  },
);

test.each([
  [
    { outcome: "TRANSITIONED", version: { status: "READY" } },
    { outcome: "TRANSITIONED", status: "READY" },
  ],
  [
    { outcome: "TRANSITIONED", version: { status: "FAILED" } },
    { outcome: "TRANSITIONED", status: "FAILED" },
  ],
  [
    { outcome: "ALREADY_TERMINAL", status: "READY" },
    { outcome: "ALREADY_TERMINAL", status: "READY" },
  ],
  [{ outcome: "NOT_FOUND" }, { outcome: "NOT_FOUND" }],
  [
    {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OPERATIONAL_FAILURE",
    },
    {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OPERATIONAL_FAILURE",
    },
  ],
  [
    {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OUTCOME_UNKNOWN",
    },
    {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OUTCOME_UNKNOWN",
    },
  ],
] as const)(
  "mapeia outcome real %# para DTO seguro",
  async (pipeline, expected) => {
    mocks.process.mockResolvedValueOnce(pipeline);
    const result = await processDatasetAction(initial, form());
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toMatch(/stack|storage|sql/i);
  },
);

test("converte exceção inesperada em falha segura", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.metadata.mockRejectedValueOnce(
    new Error("password=secret SQL raw path"),
  );
  await expect(processDatasetAction(initial, form())).resolves.toEqual({
    outcome: "OPERATIONAL_FAILURE",
    code: "PROCESSING_OPERATIONAL_FAILURE",
    message:
      "Não foi possível concluir o processamento. Verifique o estado antes de tentar novamente.",
  });
});
