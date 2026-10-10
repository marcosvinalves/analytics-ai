import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import {
  resetTestDatabase,
  testDatabaseUrl,
} from "../integration/helpers/database.ts";

const organizationId = "20000000-0000-4000-8000-000000000008";
const workspaceId = "10000000-0000-4000-8000-000000000008";
const storageRoot = path.resolve(".local/preview-e2e-storage");
const source = path.resolve("tests/fixtures/dataset-processing/valid.csv");
const columns = [
  ["id", "BIGINT", 0],
  ["produto", "VARCHAR", 0],
  ["quantidade", "BIGINT", 0],
  ["preco_unitario", "DOUBLE", 0],
  ["data", "DATE", 0],
  ["ativo", "BOOLEAN", 0],
  ["opcional", "VARCHAR", 1],
] as const;

let pool: Pool;
let datasetId: string;
let versionId: string;
let rawPath: string;
let metadataBefore: string;
let rawHashBefore: string;

async function snapshot() {
  return JSON.stringify(
    await Promise.all(
      [
        "organizations",
        "workspaces",
        "datasets",
        "dataset_versions",
        "dataset_columns",
      ].map(
        async (table) =>
          (await pool.query(`SELECT * FROM app.${table} ORDER BY id`)).rows,
      ),
    ),
  );
}

async function sha256(filename: string) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

test.beforeAll(async () => {
  await resetTestDatabase();
  await rm(storageRoot, { recursive: true, force: true });
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await pool.query(
    "INSERT INTO app.organizations(id,name) VALUES($1,'Preview E2E')",
    [organizationId],
  );
  await pool.query(
    "INSERT INTO app.workspaces(id,organization_id,name) VALUES($1,$2,'Preview E2E')",
    [workspaceId, organizationId],
  );
  datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name,description) VALUES($1,'Preview E2E','Fixture isolada') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id;
  versionId = randomUUID();
  const storageKey = rawStorageKey(workspaceId, versionId);
  rawPath = path.join(storageRoot, storageKey);
  await mkdir(path.dirname(rawPath), { recursive: true });
  await copyFile(source, rawPath);
  const bytes = await readFile(rawPath);
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,status,row_count,column_count,processed_at,original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'READY',2,7,statement_timestamp(),'valid.csv',$4)`,
    [versionId, datasetId, storageKey, bytes.length],
  );
  for (let index = 0; index < columns.length; index += 1) {
    const [name, type, nullCount] = columns[index];
    await pool.query(
      `INSERT INTO app.dataset_columns
        (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        versionId,
        name,
        type,
        index + 1,
        nullCount > 0 ? true : null,
        nullCount,
      ],
    );
  }
  metadataBefore = await snapshot();
  rawHashBefore = await sha256(rawPath);
});

test.afterAll(async () => {
  try {
    expect(await snapshot()).toBe(metadataBefore);
    expect(await sha256(rawPath)).toBe(rawHashBefore);
  } finally {
    await pool?.end();
    await rm(storageRoot, { recursive: true, force: true });
    await resetTestDatabase();
  }
});

test("fixture READY isolada: navegação, schema, preview e hidratação", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/data");
  await page.getByRole("link", { name: "Preview E2E", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/data/datasets/${datasetId}`));
  await expect(
    page.getByRole("heading", { name: "Preview E2E", exact: true }),
  ).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^READY$/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Schema do dataset" }).locator("tbody tr"),
  ).toHaveCount(7);
  await expect(
    page.getByRole("region", { name: "Linhas do preview" }).locator("tbody tr"),
  ).toHaveCount(2);
  await expect(
    page.getByText("Desconhecido", { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("URL direta da versão mantém metadata útil sem JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto(`/data/datasets/${datasetId}?version=${versionId}`);
    await expect(
      page.getByRole("heading", { name: "Preview E2E", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("READY", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("versão ausente ou inválida retorna HTTP 404", async ({ request }) => {
  for (const url of [
    "/data/datasets/invalid",
    `/data/datasets/${datasetId}?version=11111111-1111-4111-8111-111111111111`,
  ])
    expect((await request.get(url)).status()).toBe(404);
});
