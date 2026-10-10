import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { getDatabaseConfig } from "../../../src/lib/db/config.ts";

const execute = promisify(execFile);

export function testDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      "TEST_DATABASE_URL é obrigatória; integração não foi executada.",
    );
  getDatabaseConfig(value);
  const parsed = new URL(value);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new Error("PostgreSQL de teste deve usar exclusivamente loopback.");
  if (parsed.port !== "5433")
    throw new Error(
      "PostgreSQL de teste deve usar exclusivamente a porta 5433.",
    );
  if (!name.endsWith("_test"))
    throw new Error("O database de integração deve terminar em _test.");
  if (
    ["postgres", "smartcompra", "analytics_metadata"].includes(
      name.toLowerCase(),
    )
  )
    throw new Error("Database informado não é descartável para integração.");
  if (
    process.env.DATABASE_URL &&
    decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)) ===
      name
  ) {
    throw new Error(
      "O database de integração deve ser diferente do database da aplicação.",
    );
  }
  return value;
}

export async function connectTestDatabase(): Promise<Client> {
  const url = testDatabaseUrl();
  const client = new Client(getDatabaseConfig(url));
  try {
    await client.connect();
    const actual = await client.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (
      actual.rows[0].name !== decodeURIComponent(new URL(url).pathname.slice(1))
    ) {
      throw new Error(
        "O database conectado difere do database de teste solicitado.",
      );
    }
    const version = await client.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    if (version.rows[0].version !== "18.6")
      throw new Error("Testes exigem PostgreSQL server_version 18.6.");
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

export async function runDatabaseCommand(command: "check" | "migrate") {
  const args = command === "check" ? ["--conditions=react-server"] : [];
  return execute(process.execPath, [...args, `scripts/db/${command}.ts`], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    timeout: 15000,
  });
}

/** Resets only the explicitly configured disposable *_test database. */
export async function resetTestDatabase(): Promise<void> {
  const client = await connectTestDatabase();
  try {
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS migration_metadata CASCADE");
  } finally {
    await client.end();
  }
  await runDatabaseCommand("migrate");
}
