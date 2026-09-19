import "server-only";
import { Pool } from "pg";
import { getDatabaseConfig } from "./config.ts";

const metadataGlobal = globalThis as typeof globalThis & {
  metadataPool?: Pool;
};

/** Pool nativo do pg, criado sob demanda e preservado durante hot reload. */
export function getMetadataPool(): Pool {
  if (!metadataGlobal.metadataPool) {
    const pool = new Pool({
      ...getDatabaseConfig(),
      max: 5,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
    });
    pool.on("error", () => {
      // Erros brutos podem conter informações da conexão.
      console.error("METADATA_DB_IDLE_CONNECTION_ERROR");
    });
    metadataGlobal.metadataPool = pool;
  }
  return metadataGlobal.metadataPool;
}

export async function closeMetadataPool(): Promise<void> {
  const pool = metadataGlobal.metadataPool;
  delete metadataGlobal.metadataPool;
  await pool?.end();
}
