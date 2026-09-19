import type { Pool } from "pg";
import { expect, test, vi } from "vitest";
import {
  insertUploadMetadata,
  type UploadMetadata,
} from "../../src/modules/dataset/infrastructure/insert-upload-metadata.ts";

const input: UploadMetadata = {
  datasetId: "dataset",
  versionId: "version",
  workspaceId: "workspace",
  organizationId: "org",
  name: "Vendas",
  originalFilename: "vendas.csv",
  sizeBytes: 20,
  object: { namespace: "raw", key: "key" },
};
function fakePool(failure: "insert" | "commit" | "rollback", found = false) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("INSERT") && failure !== "commit")
        throw new Error("DB error");
      if (sql === "COMMIT" && failure === "commit")
        throw new Error("connection lost");
      if (sql === "ROLLBACK" && failure === "rollback")
        throw new Error("connection lost");
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rowCount: found ? 1 : 0 })),
  };
  return { pool: pool as unknown as Pool, client, freshQuery: pool.query };
}
test("falha antes de COMMIT com rollback confirmado permite compensação", async () => {
  const { pool, client } = fakePool("insert");
  await expect(insertUploadMetadata(pool, input)).rejects.toMatchObject({
    code: "METADATA_WRITE_FAILED",
    cleanupAllowed: true,
  });
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
});
test("rollback não confirmado não permite remover o objeto", async () => {
  const { pool } = fakePool("rollback");
  await expect(insertUploadMetadata(pool, input)).rejects.toMatchObject({
    code: "UPLOAD_OUTCOME_UNKNOWN",
    cleanupAllowed: false,
  });
});
test("erro de COMMIT não é tratado como rollback mesmo quando versão ainda não aparece", async () => {
  const { pool, client, freshQuery } = fakePool("commit");
  await expect(insertUploadMetadata(pool, input)).rejects.toMatchObject({
    code: "UPLOAD_OUTCOME_UNKNOWN",
    cleanupAllowed: false,
  });
  expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
  expect(freshQuery).toHaveBeenCalledOnce();
});
test("COMMIT incerto é sucesso somente quando a consulta independente confirma o registro", async () => {
  const { pool } = fakePool("commit", true);
  await expect(insertUploadMetadata(pool, input)).resolves.toBeUndefined();
});
