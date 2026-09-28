import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import type { CreateMetricInput } from "../../src/modules/semantic/domain/metric.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";

const fieldKey = "c0000000-0000-4000-8000-000000000000";
const input: CreateMetricInput = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
  name: "count_rows",
  label: "Contagem",
  expression: {
    version: 1,
    kind: "aggregate",
    op: "COUNT",
    expression: { kind: "field", fieldKey },
  },
};

function fixture(reconcile: boolean) {
  const now = new Date("2026-09-28T12:00:00Z");
  let persisted: Record<string, unknown> | undefined;
  const writerRelease = vi.fn();
  const writerQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("SELECT r.id"))
      return { rows: [{ id: input.semanticModelRevisionId, status: "DRAFT" }] };
    if (sql.includes("SELECT field_key"))
      return {
        rows: [
          {
            field_key: fieldKey,
            semantic_type: "STRING",
            decimal_precision: null,
            decimal_scale: null,
          },
        ],
      };
    if (sql.includes("INSERT INTO app.metrics")) {
      persisted = {
        id: values?.[0],
        metric_key: values?.[1],
        semantic_model_revision_id: values?.[2],
        name: values?.[3],
        label: values?.[4],
        description: values?.[5],
        expression: JSON.parse(String(values?.[6])),
        created_at: now,
        updated_at: now,
      };
      return { rows: [persisted] };
    }
    if (sql === "COMMIT") throw new Error("connection lost after commit");
    return { rows: [], rowCount: 0 };
  });
  const readerRelease = vi.fn();
  const readerQuery = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT m.*")) return { rows: [persisted] };
    if (sql.includes("SELECT field_key, semantic_type"))
      return {
        rows: [
          {
            field_key: fieldKey,
            semantic_type: "STRING",
            decimal_precision: null,
            decimal_scale: null,
          },
        ],
      };
    if (sql.includes("FROM app.metric_field_references"))
      return { rows: [{ field_key: fieldKey }] };
    return { rows: [], rowCount: 0 };
  });
  const writer = {
    query: writerQuery,
    release: writerRelease,
  } as unknown as PoolClient;
  const reader = {
    query: readerQuery,
    release: readerRelease,
  } as unknown as PoolClient;
  const connect = reconcile
    ? vi.fn().mockResolvedValueOnce(writer).mockResolvedValueOnce(reader)
    : vi
        .fn()
        .mockResolvedValueOnce(writer)
        .mockRejectedValueOnce(new Error("database unavailable"));
  return {
    pool: { connect } as unknown as Pool,
    writerQuery,
    writerRelease,
    readerRelease,
  };
}

test("COMMIT incerto reconciliado confirma Metric e referências sem repetir INSERT", async () => {
  const { pool, writerQuery, writerRelease, readerRelease } = fixture(true);
  const result = await createMetric(pool, input);
  expect(result).toMatchObject({
    outcome: "CREATED",
    metric: {
      name: "count_rows",
      resultType: { kind: "INTEGER" },
    },
  });
  expect(writerRelease).toHaveBeenCalledWith(true);
  expect(readerRelease).toHaveBeenCalledOnce();
  expect(
    writerQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO app.metrics"),
    ),
  ).toHaveLength(1);
});

test("COMMIT incerto sem reconciliação preserva outcome unknown", async () => {
  const { pool } = fixture(false);
  await expect(createMetric(pool, input)).rejects.toThrow(
    "METRIC_OUTCOME_UNKNOWN",
  );
});
