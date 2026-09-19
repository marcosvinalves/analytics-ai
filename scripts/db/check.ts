import { getMetadataPool, closeMetadataPool } from "../../src/lib/db/index.ts";

try {
  const result = await getMetadataPool().query<{ connected: number }>(
    "SELECT 1 AS connected",
  );
  if (result.rows[0]?.connected !== 1) {
    throw new Error("Unexpected connectivity result");
  }
  console.log("METADATA_DB_OK: conexão PostgreSQL verificada.");
} catch {
  console.error(
    "METADATA_DB_CHECK_FAILED: verifique DATABASE_URL, rede, TLS e credenciais.",
  );
  process.exitCode = 1;
} finally {
  await closeMetadataPool();
}
