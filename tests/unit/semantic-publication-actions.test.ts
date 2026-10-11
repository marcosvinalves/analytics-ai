import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  headers: vi.fn(),
  pool: {},
  publish: vi.fn(),
  read: vi.fn(),
  redirect: vi.fn(),
  revalidate: vi.fn(),
  validate: vi.fn(),
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
vi.mock(
  "@/modules/semantic/infrastructure/read-semantic-metric-review",
  () => ({ readSemanticMetricReview: mocks.read }),
);
vi.mock("@/modules/semantic/infrastructure/semantic-publication", () => ({
  publishSemanticModelRevision: mocks.publish,
  validateSemanticModelRevision: mocks.validate,
}));

import {
  publishSemanticDraftAction,
  validateSemanticDraftAction,
} from "../../src/app/data/datasets/[datasetId]/semantic/publication-actions.ts";

const datasetId = "10000000-0000-4000-8000-000000000036";
const revisionId = "20000000-0000-4000-8000-000000000036";
const workspaceId = "30000000-0000-4000-8000-000000000036";

function form(publish = false) {
  const data = new FormData();
  data.append("datasetId", datasetId);
  data.append("semanticModelRevisionId", revisionId);
  if (publish) data.append("confirmPublication", "true");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockReturnValue({
    workspaceId,
    origin: "http://127.0.0.1:3017",
  });
  mocks.headers.mockResolvedValue(
    new Headers({ origin: "http://127.0.0.1:3017", host: "127.0.0.1:3017" }),
  );
  mocks.read.mockResolvedValue({
    outcome: "EDITABLE",
    review: { revision: { id: revisionId } },
  });
  mocks.validate.mockResolvedValue({
    outcome: "VALID",
    fieldCount: 3,
    metricCount: 2,
  });
  mocks.publish.mockResolvedValue({ outcome: "PUBLISHED" });
  mocks.redirect.mockImplementation(() => {
    throw new Error("NEXT_REDIRECT");
  });
});

test("rejeita FormData inexato, IDs inválidos e origem divergente", async () => {
  const missing = new FormData();
  missing.append("datasetId", datasetId);
  expect(
    (await validateSemanticDraftAction({ outcome: "IDLE" }, missing)).outcome,
  ).toBe("NOT_FOUND");

  const extra = form();
  extra.append("workspaceId", workspaceId);
  expect(
    (await validateSemanticDraftAction({ outcome: "IDLE" }, extra)).outcome,
  ).toBe("NOT_FOUND");

  mocks.headers.mockResolvedValueOnce(
    new Headers({ origin: "http://localhost:3017", host: "127.0.0.1:3017" }),
  );
  expect(
    (await validateSemanticDraftAction({ outcome: "IDLE" }, form())).outcome,
  ).toBe("NOT_FOUND");
  expect(mocks.validate).not.toHaveBeenCalled();
});

test("resolve workspace e DRAFT no servidor antes de validar", async () => {
  await expect(
    validateSemanticDraftAction({ outcome: "IDLE" }, form()),
  ).resolves.toEqual({
    outcome: "VALID",
    fieldCount: 3,
    metricCount: 2,
    message: "Válido nesta verificação",
  });
  expect(mocks.read).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    datasetId,
  });
  expect(mocks.validate).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    semanticModelRevisionId: revisionId,
  });
});

test("não valida uma revisão diferente do DRAFT autoritativo", async () => {
  mocks.read.mockResolvedValueOnce({
    outcome: "EDITABLE",
    review: {
      revision: { id: "40000000-0000-4000-8000-000000000036" },
    },
  });
  expect(
    (await validateSemanticDraftAction({ outcome: "IDLE" }, form())).outcome,
  ).toBe("STALE");
  expect(mocks.validate).not.toHaveBeenCalled();
});

test("agrupa issues em mensagens seguras sem path nem mensagem interna", async () => {
  mocks.validate.mockResolvedValueOnce({
    outcome: "INVALID",
    fieldCount: 1,
    metricCount: 1,
    issues: [
      { code: "NO_FIELDS", path: "fields", message: "internal one" },
      { code: "NO_FIELDS", path: "fields.secret", message: "internal two" },
      {
        code: "METRIC_REFERENCE_PROJECTION_MISMATCH",
        path: "metrics.uuid.fieldReferences",
        message: "sql secret",
      },
    ],
  });
  const result = await validateSemanticDraftAction({ outcome: "IDLE" }, form());
  if (result.outcome !== "INVALID") throw new Error("Expected invalid");
  expect(result.issues).toEqual([
    {
      area: "FIELDS",
      message: "Inclua ao menos um campo semântico.",
      recoveryHref: "#semantic-fields",
    },
    {
      area: "INTEGRITY",
      message:
        "As referências persistidas de uma métrica estão inconsistentes.",
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/secret|uuid|fieldReferences/);
});

test("mapeia DRAFT incompleto e preserva contagens", async () => {
  mocks.validate.mockResolvedValueOnce({
    outcome: "INVALID",
    fieldCount: 0,
    metricCount: 0,
    issues: [
      { code: "NO_FIELDS", path: "fields", message: "internal" },
      { code: "NO_METRICS", path: "metrics", message: "internal" },
    ],
  });
  const result = await validateSemanticDraftAction({ outcome: "IDLE" }, form());
  expect(result).toMatchObject({
    outcome: "INVALID",
    fieldCount: 0,
    metricCount: 0,
    issues: [{ area: "FIELDS" }, { area: "METRICS" }],
  });
});

test("publicação exige confirmação explícita e revalida o DRAFT", async () => {
  const unconfirmed = form();
  unconfirmed.append("confirmPublication", "false");
  expect(
    (await publishSemanticDraftAction({ outcome: "IDLE" }, unconfirmed))
      .outcome,
  ).toBe("NOT_FOUND");
  expect(mocks.publish).not.toHaveBeenCalled();

  await expect(
    publishSemanticDraftAction({ outcome: "IDLE" }, form(true)),
  ).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(mocks.publish).toHaveBeenCalledWith(mocks.pool, {
    workspaceId,
    semanticModelRevisionId: revisionId,
  });
  expect(mocks.redirect).toHaveBeenCalledWith(
    `/data/datasets/${datasetId}/semantic`,
  );
});

test("commit incerto retorna estado seguro, revalida e não repete writer", async () => {
  mocks.publish.mockResolvedValueOnce({
    outcome: "PUBLICATION_OUTCOME_UNKNOWN",
  });
  const result = await publishSemanticDraftAction(
    { outcome: "IDLE" },
    form(true),
  );
  expect(result).toEqual({
    outcome: "PUBLICATION_OUTCOME_UNKNOWN",
    message:
      "Não foi possível confirmar a publicação. Atualize a página antes de qualquer nova tentativa.",
  });
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(mocks.revalidate).toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

test("falhas e exceções não expõem detalhes internos", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.validate.mockRejectedValueOnce(new Error("password=secret SQL stack"));
  expect(
    await validateSemanticDraftAction({ outcome: "IDLE" }, form()),
  ).toEqual({
    outcome: "OPERATIONAL_FAILURE",
    message: "A operação está temporariamente indisponível.",
  });
});
