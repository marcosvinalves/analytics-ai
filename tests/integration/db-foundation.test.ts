import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";

const execFileAsync = promisify(execFile);

test("banco limpo: conectividade, migração e reaplicação sem tabelas de domínio", async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL é obrigatória; integração não foi executada.",
    );
  }
  const config = getDatabaseConfig(testUrl);
  const databaseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
  if (!databaseName.endsWith("_test")) {
    throw new Error("O database de integração deve terminar em _test.");
  }
  if (
    process.env.DATABASE_URL &&
    decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)) ===
      databaseName
  ) {
    throw new Error(
      "O database de integração deve ser diferente do database da aplicação.",
    );
  }

  const client = new Client(config);
  try {
    await client.connect();
    const existingSchemas = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('app', 'migration_metadata')",
    );
    const existingTables = await client.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    if (existingSchemas.rowCount || existingTables.rowCount) {
      throw new Error(
        "Use um database de teste vazio; nenhum objeto existente será removido.",
      );
    }

    const env = { ...process.env, DATABASE_URL: testUrl };
    const check = await execFileAsync(
      process.execPath,
      ["--conditions=react-server", "scripts/db/check.ts"],
      { env, timeout: 15000 },
    );
    expect(check.stdout).toContain("METADATA_DB_OK");
    const first = await execFileAsync(
      process.execPath,
      ["scripts/db/migrate.ts"],
      {
        env,
        timeout: 15000,
      },
    );
    expect(first.stdout).toContain("1 migração(ões)");

    const historyBefore = await client.query(
      "SELECT * FROM migration_metadata.history ORDER BY id",
    );
    expect(historyBefore.rowCount).toBe(1);
    const second = await execFileAsync(
      process.execPath,
      ["scripts/db/migrate.ts"],
      {
        env,
        timeout: 15000,
      },
    );
    expect(second.stdout).toContain("0 migração(ões)");
    const historyAfter = await client.query(
      "SELECT * FROM migration_metadata.history ORDER BY id",
    );
    expect(historyAfter.rows).toEqual(historyBefore.rows);
    const appSchema = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname = 'app'",
    );
    expect(appSchema.rowCount).toBe(1);
    const tables = await client.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename",
    );
    expect(tables.rows).toEqual([
      { schemaname: "migration_metadata", tablename: "history" },
    ]);
  } finally {
    await client.end();
  }
});
