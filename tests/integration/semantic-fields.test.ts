import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import {
  createSemanticField,
  listSemanticFields,
  removeSemanticField,
  updateSemanticField,
} from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let organizationId: string;
let workspaceId: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  datasetVersionId: string;
  semanticModelId: string;
  revisionId: string;
  columns: Record<string, string>;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Semantic field tests') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id, name) VALUES ($1, 'Fields') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  if (!pool) return;
  try {
    await pool.query(
      `DELETE FROM app.semantic_fields f USING app.semantic_model_revisions r,
       app.semantic_models m, app.datasets d
       WHERE f.semantic_model_revision_id = r.id AND r.semantic_model_id = m.id
         AND m.dataset_id = d.id AND d.workspace_id = $1`,
      [workspaceId],
    );
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

async function fixture(
  definitions: [string, string][] = [
    ["quantity", "BIGINT"],
    ["unit_price", "DOUBLE"],
    ["category", "VARCHAR"],
  ],
): Promise<Fixture> {
  const number = ++sequence;
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id, name) VALUES ($1, $2) RETURNING id",
      [workspaceId, `Fields ${number}`],
    )
  ).rows[0].id;
  const datasetVersionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
      (dataset_id, version_number, source_type, storage_namespace, storage_key)
      VALUES ($1, 1, 'CSV', 'semantic-fields', $2) RETURNING id`,
      [datasetId, randomUUID()],
    )
  ).rows[0].id;
  const columns: Record<string, string> = {};
  for (const [index, [name, type]] of definitions.entries()) {
    columns[name] = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
        (dataset_version_id, physical_name, inferred_type, ordinal_position, nullable, null_count)
        VALUES ($1,$2,$3,$4,NULL,0) RETURNING id`,
        [datasetVersionId, name, type, index + 1],
      )
    ).rows[0].id;
  }
  await pool.query(
    `UPDATE app.dataset_versions SET status = 'READY', row_count = 1,
     column_count = $2, processed_at = statement_timestamp() WHERE id = $1`,
    [datasetVersionId, definitions.length],
  );
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId,
    modelName: `model_${number}`,
    label: `Modelo ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  return {
    datasetId,
    datasetVersionId,
    semanticModelId: draft.model.id,
    revisionId: draft.revision.id,
    columns,
  };
}

function createInput(f: Fixture, column = "category") {
  return {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    datasetColumnId: f.columns[column],
    name: column,
    label: column === "category" ? "Categoria" : column,
    semanticType: { kind: "STRING" as const },
  };
}

async function rejectSql(
  sql: string,
  values: unknown[],
  constraint: string,
  code = "23503",
): Promise<void> {
  await expect(pool.query(sql, values)).rejects.toMatchObject({
    code,
    constraint,
  });
}

test("migration cria schema, constraints compostas, índices e trigger aprovados", async () => {
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'semantic_fields'
     ORDER BY ordinal_position`,
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    "id",
    "created_at",
    "updated_at",
    "field_key",
    "semantic_model_revision_id",
    "dataset_version_id",
    "dataset_column_id",
    "name",
    "label",
    "description",
    "semantic_type",
    "decimal_precision",
    "decimal_scale",
  ]);
  const constraints = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
     WHERE connamespace = 'app'::regnamespace
       AND conrelid IN ('app.semantic_fields'::regclass,
         'app.semantic_model_revisions'::regclass, 'app.dataset_columns'::regclass)
       AND (conname LIKE '%semantic_fields%' OR
         conname IN ('semantic_model_revisions_id_version_unique', 'dataset_columns_id_version_unique'))
     ORDER BY conname`,
  );
  expect(constraints.rows.map((row) => row.conname)).toEqual(
    expect.arrayContaining([
      "dataset_columns_id_version_unique",
      "semantic_model_revisions_id_version_unique",
      "semantic_fields_revision_version_fk",
      "semantic_fields_column_version_fk",
      "semantic_fields_key_unique",
      "semantic_fields_name_unique",
      "semantic_fields_column_unique",
      "semantic_fields_decimal_consistent",
    ]),
  );
  const trigger = await pool.query(
    `SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'app.semantic_fields'::regclass
       AND tgname = 'semantic_fields_updated_at' AND NOT tgisinternal`,
  );
  expect(trigger.rowCount).toBe(1);
});

test("FKs compostas rejeitam revisão e coluna de versões divergentes", async () => {
  const a = await fixture();
  const b = await fixture();
  const values = [
    randomUUID(),
    randomUUID(),
    a.revisionId,
    b.datasetVersionId,
    b.columns.category,
    `field_${sequence}`,
  ];
  await rejectSql(
    `INSERT INTO app.semantic_fields
      (id, field_key, semantic_model_revision_id, dataset_version_id,
       dataset_column_id, name, label, semantic_type)
     VALUES ($1,$2,$3,$4,$5,$6,'Field','STRING')`,
    values,
    "semantic_fields_revision_version_fk",
  );
  values[3] = a.datasetVersionId;
  await rejectSql(
    `INSERT INTO app.semantic_fields
      (id, field_key, semantic_model_revision_id, dataset_version_id,
       dataset_column_id, name, label, semantic_type)
     VALUES ($1,$2,$3,$4,$5,$6,'Field','STRING')`,
    values,
    "semantic_fields_column_version_fk",
  );
});

test("checks do banco rejeitam configuração DECIMAL inconsistente", async () => {
  const f = await fixture();
  const base = `INSERT INTO app.semantic_fields
    (field_key, semantic_model_revision_id, dataset_version_id,
     dataset_column_id, name, label, semantic_type, decimal_precision, decimal_scale)
    VALUES ($1,$2,$3,$4,$5,'Field',$6,$7,$8)`;
  for (const [index, values] of [
    ["DECIMAL", null, null],
    ["DECIMAL", 0, 0],
    ["DECIMAL", 39, 0],
    ["DECIMAL", 10, 11],
    ["STRING", 10, 2],
  ].entries()) {
    await rejectSql(
      base,
      [
        randomUUID(),
        f.revisionId,
        f.datasetVersionId,
        f.columns.category,
        `invalid_${index}`,
        values[0],
        values[1],
        values[2],
      ],
      "semantic_fields_decimal_consistent",
      "23514",
    );
  }
});

test("create, list, update e remove preservam id e field_key no DRAFT", async () => {
  const f = await fixture();
  expect(
    await listSemanticFields(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
    }),
  ).toEqual({
    outcome: "FOUND",
    revisionStatus: "DRAFT",
    fields: [],
  });
  const created = await createSemanticField(pool, createInput(f));
  if (created.outcome !== "CREATED") throw new Error("Expected field");
  expect(created.field).toMatchObject({
    fieldKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
    physicalName: "category",
    physicalType: "VARCHAR",
    semanticType: { kind: "STRING" },
    compatibility: { compatibility: "SAFE", reason: "DIRECT" },
  });
  const updated = await updateSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    semanticFieldId: created.field.id,
    changes: { name: "product_category", label: "Categoria do produto" },
  });
  if (updated.outcome !== "UPDATED") throw new Error("Expected update");
  expect(updated.field).toMatchObject({
    id: created.field.id,
    fieldKey: created.field.fieldKey,
    name: "product_category",
    label: "Categoria do produto",
  });
  expect(
    await updateSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: created.field.id,
      changes: { name: "product_category" },
    }),
  ).toMatchObject({ outcome: "UNCHANGED" });
  expect(
    await removeSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
      semanticFieldId: created.field.id,
    }),
  ).toEqual({ outcome: "REMOVED" });
  expect(
    await listSemanticFields(pool, {
      workspaceId,
      semanticModelRevisionId: f.revisionId,
    }),
  ).toMatchObject({
    outcome: "FOUND",
    fields: [],
  });
});

test("DOUBLE → DECIMAL exige aceite e não executa conversão", async () => {
  const f = await fixture();
  const base = {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    datasetColumnId: f.columns.unit_price,
    name: "unit_price",
    label: "Preço unitário",
    semanticType: { kind: "DECIMAL" as const, precision: 18, scale: 2 },
  };
  expect(await createSemanticField(pool, base)).toEqual({
    outcome: "EXPLICIT_CONVERSION_REQUIRED",
    compatibility: {
      compatibility: "EXPLICIT",
      reason: "ORIGINAL_DECIMAL_NOT_RECOVERABLE",
    },
  });
  const accepted = await createSemanticField(pool, {
    ...base,
    acceptExplicitConversion: true,
  });
  expect(accepted).toMatchObject({
    outcome: "CREATED",
    field: {
      physicalType: "DOUBLE",
      semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
    },
  });
});

test("DATE → DATETIME é inválido e DATE → DATE é seguro", async () => {
  const f = await fixture([["day", "DATE"]]);
  const base = {
    workspaceId,
    semanticModelRevisionId: f.revisionId,
    datasetColumnId: f.columns.day,
    name: "day",
    label: "Dia",
  };
  expect(
    await createSemanticField(pool, {
      ...base,
      semanticType: { kind: "DATETIME" },
      acceptExplicitConversion: true,
    }),
  ).toMatchObject({ outcome: "INCOMPATIBLE_TYPE" });
  expect(
    await createSemanticField(pool, {
      ...base,
      semanticType: { kind: "DATE" },
    }),
  ).toMatchObject({ outcome: "CREATED" });
});

test("wrong workspace, coluna de outra versão e revisão inexistente não revelam recursos", async () => {
  const a = await fixture();
  const b = await fixture();
  for (const candidate of [
    { ...createInput(a), workspaceId: randomUUID() },
    { ...createInput(a), semanticModelRevisionId: randomUUID() },
    { ...createInput(a), datasetColumnId: b.columns.category },
  ])
    expect(await createSemanticField(pool, candidate)).toEqual({
      outcome: "NOT_FOUND",
    });
});

test("name e coluna são únicos por revisão", async () => {
  const f = await fixture();
  const first = await createSemanticField(pool, createInput(f));
  expect(first.outcome).toBe("CREATED");
  expect(
    await createSemanticField(pool, {
      ...createInput(f, "quantity"),
      name: "category",
      semanticType: { kind: "INTEGER" },
    }),
  ).toEqual({ outcome: "CONFLICT", reason: "NAME_ALREADY_EXISTS" });
  expect(
    await createSemanticField(pool, {
      ...createInput(f),
      name: "other_category",
    }),
  ).toEqual({ outcome: "CONFLICT", reason: "DATASET_COLUMN_ALREADY_MAPPED" });
});

test.each(["PUBLISHED", "ARCHIVED"] as const)(
  "%s não permite criar, atualizar ou remover fields",
  async (status) => {
    const f = await fixture();
    const created = await createSemanticField(pool, createInput(f));
    if (created.outcome !== "CREATED") throw new Error("Expected field");
    await pool.query(
      `UPDATE app.semantic_model_revisions
       SET status = $2, published_at = statement_timestamp() WHERE id = $1`,
      [f.revisionId, status],
    );
    expect(
      await createSemanticField(pool, {
        ...createInput(f, "quantity"),
        semanticType: { kind: "INTEGER" },
      }),
    ).toEqual({
      outcome: "REVISION_NOT_EDITABLE",
      status,
    });
    expect(
      await updateSemanticField(pool, {
        workspaceId,
        semanticModelRevisionId: f.revisionId,
        semanticFieldId: created.field.id,
        changes: { label: "Outro" },
      }),
    ).toEqual({ outcome: "REVISION_NOT_EDITABLE", status });
    expect(
      await removeSemanticField(pool, {
        workspaceId,
        semanticModelRevisionId: f.revisionId,
        semanticFieldId: created.field.id,
      }),
    ).toEqual({ outcome: "REVISION_NOT_EDITABLE", status });
  },
);

test("field_key pode ser preservada explicitamente em revisão futura", async () => {
  const f = await fixture();
  const first = await createSemanticField(pool, createInput(f));
  if (first.outcome !== "CREATED") throw new Error("Expected field");
  await pool.query(
    `UPDATE app.semantic_model_revisions SET status = 'PUBLISHED',
     published_at = statement_timestamp() WHERE id = $1`,
    [f.revisionId],
  );
  const next = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId: f.datasetId,
    datasetVersionId: f.datasetVersionId,
    modelName: `model_${sequence}`,
    label: "Nova revisão",
  });
  if (next.outcome !== "CREATED") throw new Error("Expected next revision");
  const row = (
    await pool.query<{ id: string; field_key: string }>(
      `INSERT INTO app.semantic_fields
       (field_key, semantic_model_revision_id, dataset_version_id,
        dataset_column_id, name, label, semantic_type)
       VALUES ($1,$2,$3,$4,'category','Categoria','STRING')
       RETURNING id, field_key`,
      [
        first.field.fieldKey,
        next.revision.id,
        f.datasetVersionId,
        f.columns.category,
      ],
    )
  ).rows[0];
  expect(row.field_key).toBe(first.field.fieldKey);
  expect(row.id).not.toBe(first.field.id);
});

test("criação concorrente produz um field e um conflito determinístico", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  const tag = `semantic-field-race-${randomUUID()}`;
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
        PromiseSettledResult<Awaited<ReturnType<typeof createSemanticField>>>[]
      >
    | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id = $1 FOR UPDATE",
      [f.revisionId],
    );
    attempts = Promise.allSettled([
      createSemanticField(writers[0], createInput(f)),
      createSemanticField(writers[1], createInput(f)),
    ]);
    await expectBlocked(tag, 2);
    await blocker.query("COMMIT");
    const results = (await attempts).map((item) => {
      if (item.status === "rejected") throw item.reason;
      return item.value;
    });
    expect(
      results.filter((result) => result.outcome === "CREATED"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "CONFLICT"),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.semantic_fields WHERE semantic_model_revision_id = $1",
          [f.revisionId],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await attempts;
    await Promise.all(writers.map((writer) => writer.end()));
  }
});

test("lock timeout confirma rollback sem field parcial", async () => {
  const f = await fixture();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id = $1 FOR UPDATE",
      [f.revisionId],
    );
    await expect(createSemanticField(pool, createInput(f))).rejects.toThrow(
      "SEMANTIC_FIELD_WRITE_FAILED",
    );
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.semantic_fields WHERE semantic_model_revision_id = $1",
          [f.revisionId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
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
