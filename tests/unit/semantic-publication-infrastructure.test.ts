import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";

const input = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
};
const fieldKey = "c0000000-0000-4000-8000-000000000000";
const now = new Date("2026-09-28T12:00:00Z");

function revision(status: "DRAFT" | "PUBLISHED") {
  return {
    id: input.semanticModelRevisionId,
    semantic_model_id: "d0000000-0000-4000-8000-000000000000",
    dataset_version_id: "e0000000-0000-4000-8000-000000000000",
    revision_number: 1,
    status,
    label: "Modelo",
    description: null,
    published_at: status === "PUBLISHED" ? now : null,
    created_at: now,
    updated_at: now,
    model_dataset_id: "f0000000-0000-4000-8000-000000000000",
    version_dataset_id: "f0000000-0000-4000-8000-000000000000",
    dataset_version_status: "READY",
  };
}

function fixture(reconcile: boolean) {
  const release = vi.fn();
  let scopedReads = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT r.id, r.semantic_model_id")) {
      scopedReads += 1;
      return { rows: [revision("DRAFT")] };
    }
    if (sql.includes("FROM app.semantic_fields"))
      return {
        rows: [
          {
            field_key: fieldKey,
            field_dataset_version_id: "e0000000-0000-4000-8000-000000000000",
            semantic_type: "INTEGER",
            decimal_precision: null,
            decimal_scale: null,
            column_id: "10000000-0000-4000-8000-000000000000",
            column_dataset_version_id: "e0000000-0000-4000-8000-000000000000",
            inferred_type: "BIGINT",
          },
        ],
      };
    if (sql.includes("FROM app.metrics"))
      return {
        rows: [
          {
            id: "20000000-0000-4000-8000-000000000000",
            metric_key: "30000000-0000-4000-8000-000000000000",
            expression: {
              version: 1,
              kind: "aggregate",
              op: "SUM",
              expression: { kind: "field", fieldKey },
            },
          },
        ],
      };
    if (sql.includes("FROM app.metric_field_references"))
      return {
        rows: [
          {
            metric_id: "20000000-0000-4000-8000-000000000000",
            field_key: fieldKey,
          },
        ],
      };
    if (sql.startsWith("UPDATE app.semantic_model_revisions"))
      return { rows: [revision("PUBLISHED")] };
    if (sql === "COMMIT") throw new Error("connection lost after commit");
    return { rows: [], rowCount: 0 };
  });
  const writer = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(writer),
    query: vi.fn(async () => {
      if (!reconcile) throw new Error("database unavailable");
      return { rows: [revision("PUBLISHED")] };
    }),
  } as unknown as Pool;
  return { pool, query, release, scopedReads: () => scopedReads };
}

test("COMMIT incerto reconciliado confirma publicação sem repetir UPDATE", async () => {
  const { pool, query, release } = fixture(true);
  expect(await publishSemanticModelRevision(pool, input)).toMatchObject({
    outcome: "PUBLISHED",
    revision: { status: "PUBLISHED" },
  });
  expect(release).toHaveBeenCalledWith(true);
  expect(
    query.mock.calls.filter(([sql]) =>
      String(sql).startsWith("UPDATE app.semantic_model_revisions"),
    ),
  ).toHaveLength(1);
});

test("COMMIT incerto não reconciliável retorna outcome desconhecido", async () => {
  const { pool } = fixture(false);
  expect(await publishSemanticModelRevision(pool, input)).toEqual({
    outcome: "PUBLICATION_OUTCOME_UNKNOWN",
  });
});
