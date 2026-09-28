import type { Pool, PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import type { CreateSemanticFieldInput } from "../../src/modules/semantic/domain/semantic-field.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";

const input: CreateSemanticFieldInput = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
  datasetColumnId: "c0000000-0000-4000-8000-000000000000",
  name: "category",
  label: "Categoria",
  semanticType: { kind: "STRING" },
};

function commitUncertainFixture(reconcile: boolean) {
  const now = new Date("2026-09-23T12:00:00Z");
  let persisted: Record<string, unknown> | undefined;
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT r.id"))
      return {
        rows: [
          {
            id: input.semanticModelRevisionId,
            dataset_version_id: "d0000000-0000-4000-8000-000000000000",
            status: "DRAFT",
          },
        ],
      };
    if (sql.startsWith("SELECT id, dataset_version_id"))
      return {
        rows: [
          {
            id: input.datasetColumnId,
            dataset_version_id: "d0000000-0000-4000-8000-000000000000",
            physical_name: "category",
            inferred_type: "VARCHAR",
            ordinal_position: 1,
          },
        ],
      };
    if (sql.includes("bool_or(field_key"))
      return {
        rows: [
          {
            field_key_conflict: false,
            name_conflict: false,
            column_conflict: false,
          },
        ],
      };
    if (sql.startsWith("WITH inserted AS")) {
      persisted = {
        id: values?.[0],
        field_key: values?.[1],
        semantic_model_revision_id: values?.[2],
        dataset_version_id: values?.[3],
        dataset_column_id: values?.[4],
        name: values?.[5],
        label: values?.[6],
        description: values?.[7],
        semantic_type: values?.[8],
        decimal_precision: values?.[9],
        decimal_scale: values?.[10],
        created_at: now,
        updated_at: now,
        physical_name: "category",
        inferred_type: "VARCHAR",
        ordinal_position: 1,
      };
      return { rows: [persisted] };
    }
    if (sql === "COMMIT") throw new Error("connection lost after commit");
    return { rows: [] };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: reconcile
      ? vi.fn().mockImplementation(async () => ({ rows: [persisted] }))
      : vi.fn().mockRejectedValue(new Error("database unavailable")),
  } as unknown as Pool;
  return { pool, query, release };
}

test("COMMIT incerto reconciliado confirma o field sem repetir INSERT", async () => {
  const { pool, query, release } = commitUncertainFixture(true);
  const result = await createSemanticField(pool, input);
  expect(result).toMatchObject({
    outcome: "CREATED",
    field: {
      name: "category",
      physicalType: "VARCHAR",
      semanticType: { kind: "STRING" },
    },
  });
  expect(release).toHaveBeenCalledWith(true);
  expect(
    query.mock.calls.filter(([sql]) => String(sql).startsWith("WITH inserted")),
  ).toHaveLength(1);
});

test("COMMIT incerto sem reconciliação confirmada preserva outcome unknown", async () => {
  const { pool } = commitUncertainFixture(false);
  await expect(createSemanticField(pool, input)).rejects.toThrow(
    "SEMANTIC_FIELD_OUTCOME_UNKNOWN",
  );
});
