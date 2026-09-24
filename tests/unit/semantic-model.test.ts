import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import {
  normalizedDescription,
  validateCreateSemanticModelDraftInput,
  type CreateSemanticModelDraftInput,
} from "../../src/modules/semantic/domain/semantic-model.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";

const valid: CreateSemanticModelDraftInput = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  datasetId: "b0000000-0000-4000-8000-000000000000",
  datasetVersionId: "c0000000-0000-4000-8000-000000000000",
  modelName: "sales_model",
  label: "Modelo de vendas",
  description: "Definições aprovadas para vendas",
};

test("aceita contrato válido e normaliza descrição ausente", () => {
  expect(() => validateCreateSemanticModelDraftInput(valid)).not.toThrow();
  expect(normalizedDescription(undefined)).toBeNull();
  expect(normalizedDescription(null)).toBeNull();
  expect(normalizedDescription("Descrição")).toBe("Descrição");
});

test.each([
  "",
  "Sales",
  "1_sales",
  "sales-model",
  "sales model",
  "área",
  "a".repeat(64),
])("rejeita modelName inválido %s", (modelName) => {
  expect(() =>
    validateCreateSemanticModelDraftInput({ ...valid, modelName }),
  ).toThrow(TypeError);
});

test("COMMIT incerto é reconciliado por estado exato sem nova escrita", async () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const modelId = "d0000000-0000-4000-8000-000000000000";
  const revisionId = "e0000000-0000-4000-8000-000000000000";
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT v.status"))
      return { rows: [{ status: "READY" }] };
    if (sql.includes("FROM app.semantic_models") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: modelId,
            dataset_id: valid.datasetId,
            name: valid.modelName,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    if (
      sql.includes("FROM app.semantic_model_revisions") &&
      sql.includes("status = 'DRAFT'")
    )
      return { rows: [] };
    if (sql.includes("MAX(revision_number)"))
      return { rows: [{ next_number: 1 }] };
    if (sql.startsWith("INSERT INTO app.semantic_model_revisions"))
      return {
        rows: [
          {
            id: revisionId,
            semantic_model_id: modelId,
            dataset_version_id: valid.datasetVersionId,
            revision_number: 1,
            status: "DRAFT",
            label: valid.label,
            description: valid.description,
            published_at: null,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    if (sql === "COMMIT") throw new Error("connection lost after commit");
    return { rows: [] };
  });
  const reconcile = vi.fn().mockResolvedValue({
    rows: [
      {
        id: modelId,
        dataset_id: valid.datasetId,
        name: valid.modelName,
        created_at: now,
        updated_at: now,
        revision_id: revisionId,
        semantic_model_id: modelId,
        dataset_version_id: valid.datasetVersionId,
        revision_number: 1,
        status: "DRAFT",
        label: valid.label,
        description: valid.description,
        published_at: null,
        revision_created_at: now,
        revision_updated_at: now,
      },
    ],
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: reconcile,
  } as unknown as Pool;

  const result = await createSemanticModelDraft(pool, valid);
  expect(result).toMatchObject({
    outcome: "EXISTING",
    model: { id: modelId },
    revision: { id: revisionId, revisionNumber: 1 },
  });
  expect(release).toHaveBeenCalledWith(true);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(
    query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT")),
  ).toHaveLength(2);
});

test("COMMIT incerto não confirmado retorna outcome unknown", async () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const modelId = "d0000000-0000-4000-8000-000000000000";
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT v.status"))
      return { rows: [{ status: "READY" }] };
    if (sql.includes("FROM app.semantic_models") && sql.includes("FOR UPDATE"))
      return {
        rows: [
          {
            id: modelId,
            dataset_id: valid.datasetId,
            name: valid.modelName,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    if (
      sql.includes("FROM app.semantic_model_revisions") &&
      sql.includes("status = 'DRAFT'")
    )
      return { rows: [] };
    if (sql.includes("MAX(revision_number)"))
      return { rows: [{ next_number: 1 }] };
    if (sql.startsWith("INSERT INTO app.semantic_model_revisions"))
      return {
        rows: [
          {
            id: "e0000000-0000-4000-8000-000000000000",
            semantic_model_id: modelId,
            dataset_version_id: valid.datasetVersionId,
            revision_number: 1,
            status: "DRAFT",
            label: valid.label,
            description: valid.description,
            published_at: null,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    if (sql === "COMMIT") throw new Error("connection lost after commit");
    return { rows: [] };
  });
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    query: vi.fn().mockRejectedValue(new Error("database unavailable")),
  } as unknown as Pool;

  await expect(createSemanticModelDraft(pool, valid)).rejects.toThrow(
    "SEMANTIC_DRAFT_OUTCOME_UNKNOWN",
  );
});

test.each([
  { workspaceId: "bad" },
  { datasetId: "bad" },
  { datasetVersionId: "bad" },
  { label: "" },
  { label: " label" },
  { label: "x".repeat(201) },
  { description: "" },
  { description: " descrição" },
  { description: "x".repeat(2001) },
])("rejeita input estrutural inválido %#", (change) => {
  expect(() =>
    validateCreateSemanticModelDraftInput({ ...valid, ...change }),
  ).toThrow(TypeError);
});
