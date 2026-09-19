import { connectTestDatabase, runDatabaseCommand } from "./helpers/database.ts";

// Uma preparação por execução; sem dependência da ordem dos arquivos de teste.
export default async function setup() {
  const client = await connectTestDatabase();
  try {
    const schemas = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname IN ('app', 'migration_metadata')",
    );
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    );
    if (schemas.rowCount || tables.rowCount) {
      throw new Error(
        "Use um database de teste vazio; objetos preexistentes não serão removidos.",
      );
    }
    const result = await runDatabaseCommand("migrate");
    if (!result.stdout.includes("2 migração(ões)")) {
      throw new Error(
        "Banco limpo deve receber exatamente as migrações T-002 e T-003.",
      );
    }
  } finally {
    await client.end();
  }
}
