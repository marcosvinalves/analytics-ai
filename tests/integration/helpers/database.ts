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
  const name = decodeURIComponent(new URL(value).pathname.slice(1));
  if (!name.endsWith("_test"))
    throw new Error("O database de integração deve terminar em _test.");
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
