import { runner } from "node-pg-migrate";
import { expect, test } from "vitest";
import { connectTestDatabase, runDatabaseCommand } from "./helpers/database.ts";

const domainTables = [
  "dataset_columns",
  "dataset_versions",
  "datasets",
  "organizations",
  "workspaces",
];

test("banco limpo: conectividade, cinco tabelas e reaplicação sem mudanças", async () => {
  const client = await connectTestDatabase();
  try {
    expect((await runDatabaseCommand("check")).stdout).toContain(
      "METADATA_DB_OK",
    );
    const before = await client.query(
      "SELECT * FROM migration_metadata.history ORDER BY id",
    );
    expect(before.rowCount).toBe(3);
    expect((await runDatabaseCommand("migrate")).stdout).toContain(
      "0 migração(ões)",
    );
    const after = await client.query(
      "SELECT * FROM migration_metadata.history ORDER BY id",
    );
    expect(after.rows).toEqual(before.rows);
    const tables = await client.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename",
    );
    expect(tables.rows).toEqual([
      ...domainTables.map((tablename) => ({ schemaname: "app", tablename })),
      { schemaname: "migration_metadata", tablename: "history" },
    ]);
  } finally {
    await client.end();
  }
});

test("rollback explícito de T-003 e upgrade da fundação T-002 preservam o histórico inicial", async () => {
  const client = await connectTestDatabase();
  try {
    const baseline = await client.query(
      "SELECT * FROM migration_metadata.history ORDER BY id LIMIT 1",
    );
    // Database descartável previamente vazio; fixtures de domínio usam ROLLBACK.
    await runner({
      dbClient: client,
      dir: "migrations",
      direction: "down",
      count: 2,
      migrationsSchema: "migration_metadata",
      migrationsTable: "history",
      singleTransaction: true,
      checkOrder: true,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'app'",
    );
    expect(tables.rowCount).toBe(0);
    const functions = await client.query(
      "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'app'",
    );
    expect(functions.rowCount).toBe(0);
    expect(
      (await client.query("SELECT * FROM migration_metadata.history")).rows,
    ).toEqual(baseline.rows);
    expect((await runDatabaseCommand("migrate")).stdout).toContain(
      "2 migração(ões)",
    );
    expect(
      (
        await client.query(
          "SELECT * FROM migration_metadata.history ORDER BY id LIMIT 1",
        )
      ).rows,
    ).toEqual(baseline.rows);
    expect((await runDatabaseCommand("migrate")).stdout).toContain(
      "0 migração(ões)",
    );
  } finally {
    await client.end();
  }
});
