import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectTestDatabase } from "./helpers/database.ts";

let client: Client;
let ids: {
  organization: string;
  workspace: string;
  dataset: string;
  version: string;
  column: string;
};

async function insertHierarchy() {
  const organization = (
    await client.query<{ id: string }>(
      "INSERT INTO app.organizations (name) VALUES ('Empresa') RETURNING id",
    )
  ).rows[0].id;
  const workspace = (
    await client.query<{ id: string }>(
      "INSERT INTO app.workspaces (organization_id, name) VALUES ($1, 'Principal') RETURNING id",
      [organization],
    )
  ).rows[0].id;
  const dataset = (
    await client.query<{ id: string }>(
      "INSERT INTO app.datasets (workspace_id, name) VALUES ($1, 'Vendas') RETURNING id",
      [workspace],
    )
  ).rows[0].id;
  const version = (
    await client.query<{ id: string }>(
      "INSERT INTO app.dataset_versions (dataset_id, version_number, source_type, storage_namespace, storage_key) VALUES ($1, 1, 'CSV', 'test', $2) RETURNING id",
      [dataset, randomUUID()],
    )
  ).rows[0].id;
  const column = (
    await client.query<{ id: string }>(
      "INSERT INTO app.dataset_columns (dataset_version_id, physical_name, inferred_type, ordinal_position) VALUES ($1, 'quantity', 'integer', 1) RETURNING id",
      [version],
    )
  ).rows[0].id;
  return { organization, workspace, dataset, version, column };
}

beforeEach(async () => {
  client = await connectTestDatabase();
  await client.query("BEGIN");
  ids = await insertHierarchy();
});

afterEach(async () => {
  if (client) {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

async function rejectsSql(
  sql: string,
  values: unknown[],
  code: string,
  constraint?: string,
) {
  await client.query("SAVEPOINT expected_failure");
  try {
    await expect(client.query(sql, values)).rejects.toMatchObject({
      code,
      ...(constraint ? { constraint } : {}),
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    await client.query("RELEASE SAVEPOINT expected_failure");
  }
}

test("IDs gerados no banco são UUIDv4 distintos e timestamps têm defaults", async () => {
  expect(new Set(Object.values(ids)).size).toBe(5);
  for (const id of Object.values(ids))
    expect(id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  for (const table of [
    "organizations",
    "workspaces",
    "datasets",
    "dataset_versions",
    "dataset_columns",
  ]) {
    const row = (
      await client.query(`SELECT created_at, updated_at FROM app.${table}`)
    ).rows[0];
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toEqual(row.created_at);
  }
  const row = (
    await client.query(
      "SELECT status, row_count, column_count, processed_at, processing_error_code, processing_error_message FROM app.dataset_versions",
    )
  ).rows[0];
  expect(row).toEqual({
    status: "PROCESSING",
    row_count: null,
    column_count: null,
    processed_at: null,
    processing_error_code: null,
    processing_error_message: null,
  });
  expect(
    (
      await client.query(
        "SELECT nullable, null_count, profile_metadata FROM app.dataset_columns",
      )
    ).rows[0],
  ).toEqual({ nullable: null, null_count: null, profile_metadata: null });
});

test("duas organizações resolvem ownership somente por suas cadeias de FKs", async () => {
  const other = await insertHierarchy();
  const rows = (
    await client.query(
      "SELECT c.id, o.id AS organization_id FROM app.dataset_columns c JOIN app.dataset_versions v ON v.id = c.dataset_version_id JOIN app.datasets d ON d.id = v.dataset_id JOIN app.workspaces w ON w.id = d.workspace_id JOIN app.organizations o ON o.id = w.organization_id WHERE c.id = ANY($1::uuid[])",
      [[ids.column, other.column]],
    )
  ).rows;
  expect(rows).toEqual(
    expect.arrayContaining([
      { id: ids.column, organization_id: ids.organization },
      { id: other.column, organization_id: other.organization },
    ]),
  );
  expect(rows).toHaveLength(2);
});

const relationships = [
  [
    "workspaces",
    "organization_id",
    "organizations",
    "workspaces_organization_fk",
  ],
  ["datasets", "workspace_id", "workspaces", "datasets_workspace_fk"],
  ["dataset_versions", "dataset_id", "datasets", "dataset_versions_dataset_fk"],
  [
    "dataset_columns",
    "dataset_version_id",
    "dataset_versions",
    "dataset_columns_version_fk",
  ],
] as const;

test.each(relationships)(
  "%s rejeita pai ausente/inexistente e restringe exclusão/alteração da PK do pai",
  async (table, fk, parent, constraint) => {
    await rejectsSql(
      `UPDATE app.${table} SET ${fk} = $1`,
      [randomUUID()],
      "23503",
      constraint,
    );
    await rejectsSql(`UPDATE app.${table} SET ${fk} = NULL`, [], "23502");
    await rejectsSql(`DELETE FROM app.${parent}`, [], "23001", constraint);
    await rejectsSql(
      `UPDATE app.${parent} SET id = $1`,
      [randomUUID()],
      "23001",
      constraint,
    );
  },
);

test("mesma versão numérica em datasets diferentes é válida; duplicação no mesmo dataset falha", async () => {
  await insertHierarchy();
  await rejectsSql(
    "INSERT INTO app.dataset_versions (dataset_id, version_number, source_type, storage_namespace, storage_key) VALUES ($1, 1, 'CSV', 'test', $2)",
    [ids.dataset, randomUUID()],
    "23505",
    "dataset_versions_number_unique",
  );
});

test("referência de storage não pode ser compartilhada entre versões", async () => {
  const storage = (
    await client.query(
      "SELECT storage_namespace, storage_key FROM app.dataset_versions WHERE id = $1",
      [ids.version],
    )
  ).rows[0];
  await rejectsSql(
    "INSERT INTO app.dataset_versions (dataset_id, version_number, source_type, storage_namespace, storage_key) VALUES ($1, 2, 'CSV', $2, $3)",
    [ids.dataset, storage.storage_namespace, storage.storage_key],
    "23505",
    "dataset_versions_storage_unique",
  );
});

test("colunas exigem nome e ordinal únicos dentro da versão", async () => {
  await rejectsSql(
    "INSERT INTO app.dataset_columns (dataset_version_id, physical_name, inferred_type, ordinal_position) VALUES ($1, 'other', 'text', 1)",
    [ids.version],
    "23505",
    "dataset_columns_ordinal_unique",
  );
  await rejectsSql(
    "INSERT INTO app.dataset_columns (dataset_version_id, physical_name, inferred_type, ordinal_position) VALUES ($1, 'quantity', 'text', 2)",
    [ids.version],
    "23505",
    "dataset_columns_name_unique",
  );
  // O mesmo nome/ordinal em outra versão é permitido.
  await insertHierarchy();
});

test("nome físico é case-sensitive", async () => {
  await client.query(
    "INSERT INTO app.dataset_columns (dataset_version_id, physical_name, inferred_type, ordinal_position) VALUES ($1, 'Quantity', 'integer', 2)",
    [ids.version],
  );
});

test.each([
  ["organizations", "name", "organizations_name_nonempty"],
  ["workspaces", "name", "workspaces_name_nonempty"],
  ["datasets", "name", "datasets_name_nonempty"],
  ["dataset_versions", "source_type", "dataset_versions_source_nonempty"],
  [
    "dataset_versions",
    "storage_namespace",
    "dataset_versions_namespace_nonempty",
  ],
  ["dataset_versions", "storage_key", "dataset_versions_key_nonempty"],
  ["dataset_columns", "physical_name", "dataset_columns_name_nonempty"],
  ["dataset_columns", "inferred_type", "dataset_columns_type_nonempty"],
])("%s.%s rejeita texto vazio e NULL", async (table, column, constraint) => {
  await rejectsSql(
    `UPDATE app.${table} SET ${column} = '   '`,
    [],
    "23514",
    constraint,
  );
  await rejectsSql(`UPDATE app.${table} SET ${column} = NULL`, [], "23502");
});

test("source_type permite vocabulário futuro sem implementar conectores", async () => {
  await client.query(
    "UPDATE app.dataset_versions SET source_type = 'FUTURE_SOURCE_TEST'",
  );
  expect(
    (await client.query("SELECT source_type FROM app.dataset_versions")).rows[0]
      .source_type,
  ).toBe("FUTURE_SOURCE_TEST");
});

test.each([
  ["dataset_versions", "version_number", 0, "dataset_versions_number_positive"],
  ["dataset_versions", "row_count", -1, "dataset_versions_rows_nonnegative"],
  [
    "dataset_versions",
    "column_count",
    -1,
    "dataset_versions_columns_nonnegative",
  ],
  [
    "dataset_columns",
    "ordinal_position",
    0,
    "dataset_columns_ordinal_positive",
  ],
  [
    "dataset_columns",
    "null_count",
    -1,
    "dataset_columns_null_count_nonnegative",
  ],
])(
  "%s.%s rejeita contagem/posição inválida",
  async (table, column, value, constraint) => {
    await rejectsSql(
      `UPDATE app.${table} SET ${column} = $1`,
      [value],
      "23514",
      constraint,
    );
  },
);

test.each(["PENDING", "ready", ""])("status %s é rejeitado", async (status) => {
  await rejectsSql(
    "UPDATE app.dataset_versions SET status = $1",
    [status],
    "23514",
  );
});

test("status NULL é rejeitado", async () => {
  await rejectsSql(
    "UPDATE app.dataset_versions SET status = NULL",
    [],
    "23502",
  );
});

test.each([
  "processed_at = CURRENT_TIMESTAMP",
  "processing_error_code = 'ERROR'",
  "processing_error_message = 'Falha'",
  "status = 'READY'",
  "status = 'READY', processed_at = CURRENT_TIMESTAMP, row_count = 0",
  "status = 'READY', processed_at = CURRENT_TIMESTAMP, column_count = 1",
  "status = 'READY', processed_at = CURRENT_TIMESTAMP, row_count = 0, column_count = 0",
  "status = 'READY', processed_at = CURRENT_TIMESTAMP, row_count = 0, column_count = 1, processing_error_code = 'ERROR'",
  "status = 'READY', processed_at = CURRENT_TIMESTAMP, row_count = 0, column_count = 1, processing_error_message = 'Falha'",
  "status = 'FAILED'",
  "status = 'FAILED', processed_at = CURRENT_TIMESTAMP",
  "status = 'FAILED', processing_error_code = 'ERROR'",
])("rejeita combinação inconsistente: %s", async (assignment) => {
  await rejectsSql(
    `UPDATE app.dataset_versions SET ${assignment}`,
    [],
    "23514",
    "dataset_versions_processing_consistent",
  );
});

test("READY aceita zero linhas com schema conhecido", async () => {
  await client.query(
    "UPDATE app.dataset_versions SET status = 'READY', row_count = 0, column_count = 1, processed_at = CURRENT_TIMESTAMP",
  );
  expect(
    (await client.query("SELECT status, row_count FROM app.dataset_versions"))
      .rows[0],
  ).toEqual({ status: "READY", row_count: "0" });
});

test("FAILED aceita contagens desconhecidas e mensagem opcional, mas exige código não vazio", async () => {
  await client.query(
    "UPDATE app.dataset_versions SET status = 'FAILED', processing_error_code = 'INVALID_SOURCE', processed_at = CURRENT_TIMESTAMP",
  );
  await rejectsSql(
    "UPDATE app.dataset_versions SET processing_error_code = ' '",
    [],
    "23514",
    "dataset_versions_error_code_nonempty",
  );
  await rejectsSql(
    "UPDATE app.dataset_versions SET processing_error_code = $1",
    ["E".repeat(65)],
    "22001",
  );
  await rejectsSql(
    "UPDATE app.dataset_versions SET processing_error_message = $1",
    ["E".repeat(2001)],
    "22001",
  );
  await client.query(
    "UPDATE app.dataset_versions SET processing_error_message = 'Arquivo inválido', row_count = 0, column_count = 0",
  );
});

test("processed_at não pode preceder created_at", async () => {
  await rejectsSql(
    "UPDATE app.dataset_versions SET status = 'FAILED', processing_error_code = 'ERROR', processed_at = created_at - interval '1 second'",
    [],
    "23514",
    "dataset_versions_processed_after_creation",
  );
});

test.each(["[]", "42", '"text"', "null"])(
  "perfil JSON %s não é objeto",
  async (value) => {
    await rejectsSql(
      "UPDATE app.dataset_columns SET profile_metadata = $1::jsonb",
      [value],
      "23514",
      "dataset_columns_profile_object",
    );
  },
);

test("perfil aceita objeto opcional, zero difere de desconhecido e bigint preserva precisão", async () => {
  await client.query(
    "UPDATE app.dataset_columns SET nullable = false, null_count = 0, profile_metadata = '{}'::jsonb",
  );
  expect(
    (
      await client.query(
        "SELECT nullable, null_count, profile_metadata FROM app.dataset_columns",
      )
    ).rows[0],
  ).toEqual({ nullable: false, null_count: "0", profile_metadata: {} });
  await client.query("UPDATE app.dataset_versions SET row_count = $1", [
    "9007199254740993",
  ]);
  expect(
    (await client.query("SELECT row_count FROM app.dataset_versions")).rows[0]
      .row_count,
  ).toBe("9007199254740993");
});

test.each([
  "organizations",
  "workspaces",
  "datasets",
  "dataset_versions",
  "dataset_columns",
])("trigger de %s mantém updated_at e preserva created_at", async (table) => {
  const before = (await client.query(`SELECT created_at FROM app.${table}`))
    .rows[0].created_at;
  const update = await client.query(
    `UPDATE app.${table} SET updated_at = '2000-01-01T00:00:00Z' RETURNING created_at, updated_at = statement_timestamp() AS maintained`,
  );
  expect(update.rows[0].created_at).toEqual(before);
  expect(update.rows[0].maintained).toBe(true);
});

test("timestamptz preserva o instante entre fusos", async () => {
  await client.query(
    "UPDATE app.organizations SET created_at = '2026-09-19T09:00:00-03:00'",
  );
  await client.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
  expect(
    (
      await client.query("SELECT created_at FROM app.organizations")
    ).rows[0].created_at.toISOString(),
  ).toBe("2026-09-19T12:00:00.000Z");
});

test("catálogo contém somente índices aprovados, FKs RESTRICT e triggers de timestamps", async () => {
  const indexes = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'app' AND tablename = ANY($1::text[]) ORDER BY indexname",
    [
      [
        "organizations",
        "workspaces",
        "datasets",
        "dataset_versions",
        "dataset_columns",
      ],
    ],
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual([
    "dataset_columns_name_unique",
    "dataset_columns_ordinal_unique",
    "dataset_columns_pkey",
    "dataset_versions_number_unique",
    "dataset_versions_pkey",
    "dataset_versions_storage_unique",
    "datasets_pkey",
    "datasets_workspace_idx",
    "organizations_pkey",
    "workspaces_organization_idx",
    "workspaces_pkey",
  ]);
  const fks = await client.query(
    "SELECT confdeltype, confupdtype FROM pg_constraint WHERE connamespace = 'app'::regnamespace AND contype = 'f' AND conrelid = ANY($1::regclass[])",
    [
      [
        "app.workspaces",
        "app.datasets",
        "app.dataset_versions",
        "app.dataset_columns",
      ],
    ],
  );
  expect(fks.rows).toHaveLength(4);
  for (const row of fks.rows)
    expect(row).toEqual({ confdeltype: "r", confupdtype: "r" });
  const triggers = await client.query(
    "SELECT t.tgname, p.proname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid WHERE c.relnamespace = 'app'::regnamespace AND c.relname = ANY($1::text[]) AND NOT t.tgisinternal",
    [
      [
        "organizations",
        "workspaces",
        "datasets",
        "dataset_versions",
        "dataset_columns",
      ],
    ],
  );
  expect(triggers.rows).toHaveLength(5);
  for (const row of triggers.rows) expect(row.proname).toBe("set_updated_at");
  const columns = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = ANY($1::text[])",
    [
      [
        "organizations",
        "workspaces",
        "datasets",
        "dataset_versions",
        "dataset_columns",
      ],
    ],
  );
  expect(
    columns.rows.filter((row) =>
      ["created_at", "updated_at", "processed_at"].includes(row.column_name),
    ),
  ).toHaveLength(11);
  for (const row of columns.rows.filter((row) =>
    row.column_name.endsWith("_at"),
  ))
    expect(row.data_type).toBe("timestamp with time zone");
  expect(columns.rows.some((row) => row.column_name === "null_ratio")).toBe(
    false,
  );
  expect(columns.rows.some((row) => row.data_type === "bytea")).toBe(false);
  expect(
    (
      await client.query(
        "SELECT relname FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relrowsecurity",
      )
    ).rowCount,
  ).toBe(0);
});
