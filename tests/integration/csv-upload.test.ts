import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { testDatabaseUrl } from "./helpers/database.ts";
import { uploadDataset } from "../../src/modules/dataset/application/upload-dataset.ts";
import {
  insertUploadMetadata,
  resolveUploadWorkspace,
} from "../../src/modules/dataset/infrastructure/insert-upload-metadata.ts";
import { LocalRawStorage } from "../../src/lib/storage/local-raw-storage.ts";
import { uploadRequest } from "../helpers/uploads.ts";

let pool: Pool;
let root: string;
let organizationId: string;
let workspaceId: string;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "csv-integration-"));
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations (name) VALUES ('Upload Test') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces (organization_id, name) VALUES ($1, 'Test') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});
afterAll(async () => {
  if (pool) {
    if (workspaceId) {
      await pool.query(
        "DELETE FROM app.dataset_versions WHERE dataset_id IN (SELECT id FROM app.datasets WHERE workspace_id = $1)",
        [workspaceId],
      );
      await pool.query("DELETE FROM app.datasets WHERE workspace_id = $1", [
        workspaceId,
      ]);
      await pool.query("DELETE FROM app.workspaces WHERE id = $1", [
        workspaceId,
      ]);
    }
    if (organizationId)
      await pool.query("DELETE FROM app.organizations WHERE id = $1", [
        organizationId,
      ]);
    await pool.end();
  }
  if (root) await rm(root, { recursive: true, force: true });
});
test("arquivo bruto e metadados persistem; zero colunas; PROCESSING/CSV; contagens desconhecidas", async () => {
  expect(await resolveUploadWorkspace(pool, workspaceId)).toBe(organizationId);
  const result = await uploadDataset(uploadRequest({ name: "Receita" }), {
    workspaceId,
    organizationId,
    storage: new LocalRawStorage(root),
    maxBytes: 100,
    signal: new AbortController().signal,
    requestId: "test",
    persist: (data) => insertUploadMetadata(pool, data),
  });
  const row = (
    await pool.query(
      "SELECT v.*, d.workspace_id, d.name FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id WHERE v.id = $1",
      [result.version.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    workspace_id: workspaceId,
    name: "Receita",
    version_number: 1,
    status: "PROCESSING",
    source_type: "CSV",
    original_filename: "vendas.csv",
    size_bytes: "20",
    row_count: null,
    column_count: null,
    processed_at: null,
    processing_error_code: null,
    processing_error_message: null,
  });
  expect(await readFile(path.join(root, row.storage_key), "utf8")).toBe(
    "quantity,price\n2,10\n",
  );
  expect(
    (
      await pool.query(
        "SELECT 1 FROM app.dataset_columns WHERE dataset_version_id = $1",
        [row.id],
      )
    ).rowCount,
  ).toBe(0);
});
test("erro SQL real após INSERT Dataset causa rollback sem dataset parcial", async () => {
  const datasetId = randomUUID();
  await expect(
    insertUploadMetadata(pool, {
      datasetId,
      versionId: randomUUID(),
      workspaceId,
      organizationId,
      name: "Rollback",
      originalFilename: "x.csv",
      sizeBytes: 0,
      object: { namespace: "raw", key: randomUUID() },
    }),
  ).rejects.toMatchObject({
    code: "METADATA_WRITE_FAILED",
    cleanupAllowed: true,
  });
  expect(
    (await pool.query("SELECT 1 FROM app.datasets WHERE id = $1", [datasetId]))
      .rowCount,
  ).toBe(0);
});
test("falha real de ownership após publicação compensa somente o novo objeto", async () => {
  const isolated = path.join(root, "rollback-storage");
  await expect(
    uploadDataset(uploadRequest(), {
      workspaceId,
      organizationId: randomUUID(),
      storage: new LocalRawStorage(isolated),
      maxBytes: 100,
      signal: new AbortController().signal,
      requestId: "test",
      persist: (data) => insertUploadMetadata(pool, data),
    }),
  ).rejects.toMatchObject({ code: "METADATA_WRITE_FAILED" });
  expect(
    (await readdir(isolated, { recursive: true })).filter((name) =>
      name.endsWith("raw.csv"),
    ),
  ).toEqual([]);
});
test("migração aditiva valida nome/tamanho e permite NULL em registros anteriores", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dataset = (
      await client.query(
        "INSERT INTO app.datasets (workspace_id, name) VALUES ($1, 'Legacy') RETURNING id",
        [workspaceId],
      )
    ).rows[0].id;
    const version = (
      await client.query(
        "INSERT INTO app.dataset_versions (dataset_id, version_number, source_type, storage_namespace, storage_key) VALUES ($1, 1, 'CSV', 'raw', $2) RETURNING id, original_filename, size_bytes",
        [dataset, randomUUID()],
      )
    ).rows[0];
    expect(version.original_filename).toBeNull();
    expect(version.size_bytes).toBeNull();
    for (const [field, value, constraint] of [
      ["size_bytes", "0", "dataset_versions_size_positive"],
      ["original_filename", "' '", "dataset_versions_filename_nonempty"],
    ]) {
      await client.query("SAVEPOINT invalid_upload");
      await expect(
        client.query(
          `UPDATE app.dataset_versions SET ${field} = ${value} WHERE id = $1`,
          [version.id],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint });
      await client.query("ROLLBACK TO SAVEPOINT invalid_upload");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
