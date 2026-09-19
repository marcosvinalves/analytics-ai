import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";

try {
  const migrations = await runner({
    databaseUrl: {
      ...getDatabaseConfig(),
      statement_timeout: 60000,
      lock_timeout: 10000,
    },
    dir: fileURLToPath(new URL("../../migrations/", import.meta.url)),
    direction: "up",
    migrationsSchema: "migration_metadata",
    migrationsTable: "history",
    createMigrationsSchema: true,
    schema: "public",
    createSchema: false,
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    // Não imprimir SQL, URLs ou erros brutos que possam carregar segredos.
    logger: {
      info: () => {},
      warn: () => console.warn("METADATA_MIGRATION_WARNING"),
      error: () => {},
    },
  });
  console.log(
    `METADATA_MIGRATIONS_OK: ${migrations.length} migração(ões) aplicada(s).`,
  );
} catch {
  console.error(
    "METADATA_MIGRATION_FAILED: verifique DATABASE_URL, conectividade, permissões, histórico e arquivos SQL.",
  );
  process.exitCode = 1;
}
