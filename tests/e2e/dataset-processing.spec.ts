import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import {
  resetTestDatabase,
  testDatabaseUrl,
} from "../integration/helpers/database.ts";

const organizationId = "20000000-0000-4000-8000-000000000008";
const workspaceId = "10000000-0000-4000-8000-000000000008";
const otherWorkspaceId = "30000000-0000-4000-8000-000000000008";
const storageRoot = path.resolve(".local/preview-e2e-storage");

let pool: Pool;
let otherDatasetId: string;

test.describe.configure({ mode: "serial" });

function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function hash(filename: string) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function upload(page: Page, name: string, filename: string) {
  await page.goto("/data/upload");
  await page.getByLabel("Nome do dataset").fill(name);
  await page.getByLabel("Arquivo CSV").setInputFiles(filename);
  await page.getByRole("button", { name: "Enviar CSV" }).click();
  await expect(
    page.getByRole("status", { name: "Upload concluído" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Abrir dataset" }).click();
  await expect(
    page.locator("dd").filter({ hasText: /^PROCESSING$/ }),
  ).toBeVisible();
}

test.beforeAll(async () => {
  await resetTestDatabase();
  await rm(storageRoot, { recursive: true, force: true });
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await pool.query(
    "INSERT INTO app.organizations(id,name) VALUES($1,'Processing E2E')",
    [organizationId],
  );
  await pool.query(
    `INSERT INTO app.workspaces(id,organization_id,name)
     VALUES($1,$3,'Processing E2E'),($2,$3,'Other workspace')`,
    [workspaceId, otherWorkspaceId, organizationId],
  );
  otherDatasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,'Private dataset') RETURNING id",
      [otherWorkspaceId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'private.csv',1)`,
    [
      randomUUID(),
      otherDatasetId,
      `workspaces/${otherWorkspaceId}/versions/${randomUUID()}/raw.csv`,
    ],
  );
});

test.afterAll(async () => {
  try {
    await pool?.end();
    await rm(storageRoot, { recursive: true, force: true });
  } finally {
    await resetTestDatabase();
  }
});

test("upload real, pending, READY, schema, preview e raw imutável", async ({
  page,
}) => {
  const errors = browserErrors(page);
  await upload(
    page,
    "Processing E2E",
    path.resolve("tests/fixtures/dataset-processing/valid.csv"),
  );

  const version = (
    await pool.query(
      `SELECT v.*,d.id AS dataset_id FROM app.dataset_versions v
       JOIN app.datasets d ON d.id=v.dataset_id
       WHERE d.workspace_id=$1 AND d.name='Processing E2E'`,
      [workspaceId],
    )
  ).rows[0];
  const rawPath = path.join(storageRoot, version.storage_key);
  const rawBefore = await hash(rawPath);
  const identityBefore = {
    id: version.id,
    datasetId: version.dataset_id,
    versionNumber: version.version_number,
    sourceType: version.source_type,
    namespace: version.storage_namespace,
    key: version.storage_key,
    filename: version.original_filename,
    size: version.size_bytes,
    createdAt: version.created_at.toISOString(),
  };
  const versionsBefore = (
    await pool.query(
      "SELECT count(*)::int AS total FROM app.dataset_versions WHERE dataset_id=$1",
      [version.dataset_id],
    )
  ).rows[0].total;

  const button = page.getByRole("button", { name: "Processar dados" });
  await expect(button).toBeVisible();
  const pendingObserved = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const submit = document.querySelector<HTMLButtonElement>(
          'main button[type="submit"]',
        );
        if (!submit) return resolve(false);
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, 5000);
        const observer = new MutationObserver(() => {
          if (
            submit.disabled &&
            submit.textContent?.includes("Processando dados")
          ) {
            window.clearTimeout(timeout);
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(submit, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      }),
  );
  await button.click();
  expect(await pendingObserved).toBe(true);
  await expect(page.locator("dd").filter({ hasText: /^READY$/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Schema do dataset" }).locator("tbody tr"),
  ).toHaveCount(7);
  await expect(
    page.getByRole("region", { name: "Linhas do preview" }).locator("tbody tr"),
  ).toHaveCount(2);
  await expect(button).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByRole("status", { name: "" }).filter({
      hasText: "Carregando preview",
    }),
  ).toHaveCount(0);
  await expect(page.locator("dd").filter({ hasText: /^READY$/ })).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("button", { name: "Processar dados" }),
  ).toHaveCount(0);

  const after = (
    await pool.query("SELECT * FROM app.dataset_versions WHERE id=$1", [
      version.id,
    ])
  ).rows[0];
  expect({
    id: after.id,
    datasetId: after.dataset_id,
    versionNumber: after.version_number,
    sourceType: after.source_type,
    namespace: after.storage_namespace,
    key: after.storage_key,
    filename: after.original_filename,
    size: after.size_bytes,
    createdAt: after.created_at.toISOString(),
  }).toEqual(identityBefore);
  expect(after).toMatchObject({
    status: "READY",
    row_count: "2",
    column_count: 7,
    processing_error_code: null,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM app.dataset_versions WHERE dataset_id=$1",
        [version.dataset_id],
      )
    ).rows[0].total,
  ).toBe(versionsBefore);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS total FROM app.dataset_columns WHERE dataset_version_id=$1",
        [version.id],
      )
    ).rows[0].total,
  ).toBe(7);
  expect(await hash(rawPath)).toBe(rawBefore);
  expect(errors).toEqual([]);
});

test("CSV inválido termina FAILED sem retry nem detalhes internos", async ({
  page,
}) => {
  const errors = browserErrors(page);
  await upload(
    page,
    "Invalid Processing E2E",
    path.resolve("tests/fixtures/dataset-processing/invalid.csv"),
  );
  await page.getByRole("button", { name: "Processar dados" }).click();
  await expect(
    page.locator("dd").filter({ hasText: /^FAILED$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Processar dados" }),
  ).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Não foi possível processar esta versão",
  );
  await expect(page.getByRole("main")).not.toContainText("CSV_READ_FAILED");
  await expect(page.getByRole("main")).not.toContainText("storage_key");
  expect(errors).toEqual([]);
});

test("dataset de outro workspace permanece NOT_FOUND", async ({ request }) => {
  expect((await request.get(`/data/datasets/${otherDatasetId}`)).status()).toBe(
    404,
  );
});
