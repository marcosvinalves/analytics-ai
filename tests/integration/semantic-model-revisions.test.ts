import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let organizationId: string;
let workspaceId: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  versionId: string;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Semantic tests') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id, name) VALUES ($1, 'Semantic') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM app.semantic_model_revisions r USING app.semantic_models m, app.datasets d
      WHERE r.semantic_model_id = m.id AND m.dataset_id = d.id AND d.workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `DELETE FROM app.semantic_models m USING app.datasets d
      WHERE m.dataset_id = d.id AND d.workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `DELETE FROM app.dataset_columns c USING app.dataset_versions v, app.datasets d
      WHERE c.dataset_version_id = v.id AND v.dataset_id = d.id AND d.workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `DELETE FROM app.dataset_versions v USING app.datasets d
      WHERE v.dataset_id = d.id AND d.workspace_id = $1`,
      [workspaceId],
    );
    await pool.query("DELETE FROM app.datasets WHERE workspace_id = $1", [
      workspaceId,
    ]);
    await pool.query("DELETE FROM app.workspaces WHERE id = $1", [workspaceId]);
    await pool.query("DELETE FROM app.organizations WHERE id = $1", [
      organizationId,
    ]);
  } finally {
    await pool.end();
  }
});

async function makeDataset(
  status: "PROCESSING" | "READY" | "FAILED" = "READY",
): Promise<Fixture> {
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id, name) VALUES ($1, $2) RETURNING id",
      [workspaceId, `Dataset ${++sequence}`],
    )
  ).rows[0].id;
  const versionId = await makeVersion(datasetId, 1, status);
  return { datasetId, versionId };
}

async function makeVersion(
  datasetId: string,
  versionNumber: number,
  status: "PROCESSING" | "READY" | "FAILED" = "READY",
): Promise<string> {
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
      (dataset_id, version_number, source_type, storage_namespace, storage_key)
      VALUES ($1, $2, 'CSV', 'semantic-test', $3) RETURNING id`,
      [datasetId, versionNumber, randomUUID()],
    )
  ).rows[0].id;
  if (status === "READY") {
    await pool.query(
      `UPDATE app.dataset_versions SET status = 'READY', row_count = 1,
      column_count = 1, processed_at = statement_timestamp() WHERE id = $1`,
      [versionId],
    );
    await pool.query(
      `INSERT INTO app.dataset_columns
      (dataset_version_id, physical_name, inferred_type, ordinal_position, nullable, null_count)
      VALUES ($1, 'quantity', 'BIGINT', 1, NULL, 0)`,
      [versionId],
    );
  } else if (status === "FAILED") {
    await pool.query(
      `UPDATE app.dataset_versions SET status = 'FAILED',
      processing_error_code = 'CSV_READ_FAILED', processed_at = statement_timestamp()
      WHERE id = $1`,
      [versionId],
    );
  }
  return versionId;
}

function input(fixture: Fixture) {
  return {
    workspaceId,
    datasetId: fixture.datasetId,
    datasetVersionId: fixture.versionId,
    modelName: "sales_model",
    label: "Modelo de vendas",
    description: "Definições de vendas",
  };
}

async function publishFixture(revisionId: string): Promise<void> {
  await pool.query(
    `UPDATE app.semantic_model_revisions
    SET status = 'PUBLISHED', published_at = statement_timestamp() WHERE id = $1`,
    [revisionId],
  );
}

test("catálogo contém somente o schema semântico aprovado", async () => {
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name LIKE 'semantic_model%'
    ORDER BY table_name, ordinal_position`,
  );
  expect(columns.rows.map((row) => [row.table_name, row.column_name])).toEqual([
    ["semantic_model_revisions", "id"],
    ["semantic_model_revisions", "created_at"],
    ["semantic_model_revisions", "updated_at"],
    ["semantic_model_revisions", "semantic_model_id"],
    ["semantic_model_revisions", "dataset_version_id"],
    ["semantic_model_revisions", "revision_number"],
    ["semantic_model_revisions", "status"],
    ["semantic_model_revisions", "label"],
    ["semantic_model_revisions", "description"],
    ["semantic_model_revisions", "published_at"],
    ["semantic_models", "id"],
    ["semantic_models", "created_at"],
    ["semantic_models", "updated_at"],
    ["semantic_models", "dataset_id"],
    ["semantic_models", "name"],
  ]);
  expect(
    columns.rows.some(
      (row) =>
        row.column_name === "dataset_id" &&
        row.table_name === "semantic_model_revisions",
    ),
  ).toBe(false);
  expect(columns.rows.some((row) => row.column_name === "archived_at")).toBe(
    false,
  );
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
    WHERE schemaname = 'app' AND tablename LIKE 'semantic_model%'
    ORDER BY indexname`,
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "semantic_model_revisions_number_unique",
    "semantic_model_revisions_one_draft_idx",
    "semantic_model_revisions_one_published_idx",
    "semantic_model_revisions_pkey",
    "semantic_model_revisions_version_idx",
    "semantic_models_dataset_unique",
    "semantic_models_pkey",
  ]);
  const triggers = await pool.query(
    `SELECT c.relname, p.proname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE c.relnamespace = 'app'::regnamespace
      AND c.relname LIKE 'semantic_model%' AND NOT t.tgisinternal`,
  );
  expect(triggers.rows).toEqual(
    expect.arrayContaining([
      { relname: "semantic_models", proname: "set_updated_at" },
      { relname: "semantic_model_revisions", proname: "set_updated_at" },
    ]),
  );
  expect(triggers.rows).toHaveLength(2);
});

test("READY cria modelo e draft sem alterar metadados do EPIC-01", async () => {
  const fixture = await makeDataset();
  const before = (
    await pool.query(
      `SELECT d.*, row_to_json(v) AS version,
        (SELECT json_agg(c ORDER BY c.ordinal_position) FROM app.dataset_columns c
         WHERE c.dataset_version_id = v.id) AS columns
      FROM app.datasets d JOIN app.dataset_versions v ON v.dataset_id = d.id
      WHERE d.id = $1`,
      [fixture.datasetId],
    )
  ).rows[0];
  const result = await createSemanticModelDraft(pool, input(fixture));
  expect(result.outcome).toBe("CREATED");
  if (result.outcome !== "CREATED") throw new Error("Expected CREATED");
  expect(result.model).toMatchObject({
    datasetId: fixture.datasetId,
    name: "sales_model",
  });
  expect(result.revision).toMatchObject({
    semanticModelId: result.model.id,
    datasetVersionId: fixture.versionId,
    revisionNumber: 1,
    status: "DRAFT",
    label: "Modelo de vendas",
    description: "Definições de vendas",
    publishedAt: null,
  });
  const after = (
    await pool.query(
      `SELECT d.*, row_to_json(v) AS version,
        (SELECT json_agg(c ORDER BY c.ordinal_position) FROM app.dataset_columns c
         WHERE c.dataset_version_id = v.id) AS columns
      FROM app.datasets d JOIN app.dataset_versions v ON v.dataset_id = d.id
      WHERE d.id = $1`,
      [fixture.datasetId],
    )
  ).rows[0];
  expect(after).toEqual(before);
});

test.each(["PROCESSING", "FAILED"] as const)(
  "%s não cria modelo nem revisão",
  async (status) => {
    const fixture = await makeDataset(status);
    expect(await createSemanticModelDraft(pool, input(fixture))).toEqual({
      outcome: "VERSION_NOT_READY",
      status,
    });
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.semantic_models WHERE dataset_id = $1",
          [fixture.datasetId],
        )
      ).rowCount,
    ).toBe(0);
  },
);

test("recurso ausente, workspace incorreto e versão de outro dataset retornam NOT_FOUND", async () => {
  const a = await makeDataset();
  const b = await makeDataset();
  for (const value of [
    { ...input(a), datasetId: randomUUID() },
    { ...input(a), workspaceId: randomUUID() },
    { ...input(a), datasetVersionId: b.versionId },
  ]) {
    expect(await createSemanticModelDraft(pool, value)).toEqual({
      outcome: "NOT_FOUND",
    });
  }
  expect(
    (
      await pool.query(
        "SELECT 1 FROM app.semantic_models WHERE dataset_id = $1",
        [a.datasetId],
      )
    ).rowCount,
  ).toBe(0);
});

test("idempotência compara payload de criação e não sobrescreve o draft", async () => {
  const fixture = await makeDataset();
  const first = await createSemanticModelDraft(pool, input(fixture));
  const repeated = await createSemanticModelDraft(pool, input(fixture));
  expect(first.outcome).toBe("CREATED");
  expect(repeated).toEqual({ ...first, outcome: "EXISTING" });
  expect(
    await createSemanticModelDraft(pool, {
      ...input(fixture),
      label: "Outro label",
    }),
  ).toEqual({ outcome: "CONFLICT", reason: "DRAFT_ALREADY_EXISTS" });
  expect(
    await createSemanticModelDraft(pool, {
      ...input(fixture),
      modelName: "another_model",
    }),
  ).toEqual({ outcome: "CONFLICT", reason: "MODEL_NAME_MISMATCH" });
});

test("duas transações criam deterministicamente um único primeiro modelo e draft", async () => {
  const fixture = await makeDataset();
  const blocker = await pool.connect();
  const tag = `semantic-initial-${randomUUID()}`;
  const writers = [
    new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-a`,
    }),
    new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-b`,
    }),
  ];
  let attempts:
    | Promise<
        PromiseSettledResult<
          Awaited<ReturnType<typeof createSemanticModelDraft>>
        >[]
      >
    | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.datasets WHERE id = $1 FOR UPDATE",
      [fixture.datasetId],
    );
    attempts = Promise.allSettled([
      createSemanticModelDraft(writers[0], input(fixture)),
      createSemanticModelDraft(writers[1], input(fixture)),
    ]);
    await expectBlocked(tag, 2);
    await blocker.query("COMMIT");
    const results = (await attempts).map((item) => {
      if (item.status === "rejected") throw item.reason;
      return item.value;
    });
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "CREATED",
      "EXISTING",
    ]);
    const [left, right] = results;
    if (
      (left.outcome !== "CREATED" && left.outcome !== "EXISTING") ||
      (right.outcome !== "CREATED" && right.outcome !== "EXISTING")
    )
      throw new Error("Unexpected result");
    expect(left.model.id).toBe(right.model.id);
    expect(left.revision.id).toBe(right.revision.id);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM app.semantic_models m
          JOIN app.semantic_model_revisions r ON r.semantic_model_id = m.id
          WHERE m.dataset_id = $1`,
          [fixture.datasetId],
        )
      ).rows[0].count,
    ).toBe(1);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await attempts;
    await Promise.all(writers.map((writer) => writer.end()));
  }
});

test("lock do modelo serializa revision_number e permite um único novo draft", async () => {
  const fixture = await makeDataset();
  const initial = await createSemanticModelDraft(pool, input(fixture));
  if (initial.outcome !== "CREATED") throw new Error("Expected CREATED");
  await publishFixture(initial.revision.id);
  const versions = [
    await makeVersion(fixture.datasetId, 2),
    await makeVersion(fixture.datasetId, 3),
  ];
  const blocker = await pool.connect();
  const tag = `semantic-number-${randomUUID()}`;
  const writers = [
    new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-a`,
    }),
    new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-b`,
    }),
  ];
  let attempts:
    | Promise<
        PromiseSettledResult<
          Awaited<ReturnType<typeof createSemanticModelDraft>>
        >[]
      >
    | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_models WHERE id = $1 FOR UPDATE",
      [initial.model.id],
    );
    attempts = Promise.allSettled(
      versions.map((datasetVersionId, index) =>
        createSemanticModelDraft(writers[index], {
          ...input(fixture),
          datasetVersionId,
          label: `Revisão concorrente ${index + 1}`,
        }),
      ),
    );
    await expectBlocked(tag, 2);
    await blocker.query("COMMIT");
    const results = (await attempts).map((item) => {
      if (item.status === "rejected") throw item.reason;
      return item.value;
    });
    expect(
      results.filter((result) => result.outcome === "CREATED"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "CONFLICT")).toEqual([
      { outcome: "CONFLICT", reason: "DRAFT_ALREADY_EXISTS" },
    ]);
    const revisions = await pool.query(
      `SELECT revision_number, status FROM app.semantic_model_revisions
      WHERE semantic_model_id = $1 ORDER BY revision_number`,
      [initial.model.id],
    );
    expect(revisions.rows).toEqual([
      { revision_number: 1, status: "PUBLISHED" },
      { revision_number: 2, status: "DRAFT" },
    ]);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await attempts;
    await Promise.all(writers.map((writer) => writer.end()));
  }
});

test("falha de lock confirma rollback e não persiste revisão parcial", async () => {
  const fixture = await makeDataset();
  const initial = await createSemanticModelDraft(pool, input(fixture));
  if (initial.outcome !== "CREATED") throw new Error("Expected CREATED");
  await publishFixture(initial.revision.id);
  const versionId = await makeVersion(fixture.datasetId, 2);
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_models WHERE id = $1 FOR UPDATE",
      [initial.model.id],
    );
    await expect(
      createSemanticModelDraft(pool, {
        ...input(fixture),
        datasetVersionId: versionId,
        label: "Draft bloqueado",
      }),
    ).rejects.toThrow("SEMANTIC_DRAFT_WRITE_FAILED");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.semantic_model_revisions WHERE semantic_model_id = $1 AND status = 'DRAFT'",
          [initial.model.id],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

test("published_at original é preservado ao arquivar e não existe archived_at", async () => {
  const fixture = await makeDataset();
  const created = await createSemanticModelDraft(pool, input(fixture));
  if (created.outcome !== "CREATED") throw new Error("Expected CREATED");
  await publishFixture(created.revision.id);
  const publishedAt = (
    await pool.query<{ published_at: Date }>(
      "SELECT published_at FROM app.semantic_model_revisions WHERE id = $1",
      [created.revision.id],
    )
  ).rows[0].published_at;
  await pool.query(
    "UPDATE app.semantic_model_revisions SET status = 'ARCHIVED' WHERE id = $1",
    [created.revision.id],
  );
  expect(
    (
      await pool.query(
        "SELECT status, published_at FROM app.semantic_model_revisions WHERE id = $1",
        [created.revision.id],
      )
    ).rows[0],
  ).toEqual({ status: "ARCHIVED", published_at: publishedAt });
});

async function expectBlocked(tag: string, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'`,
      [[`${tag}-a`, `${tag}-b`]],
    );
    if (result.rows[0].count === count) return;
    await delay(10);
  }
  throw new Error(`Expected ${count} blocked PostgreSQL sessions`);
}
