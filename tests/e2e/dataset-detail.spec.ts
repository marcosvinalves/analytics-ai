import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

let pool: Pool;
let datasetId: string;
let versionId: string;
let name: string;
let rowCount: string;
let columnCount: number;
let filename: string;
let before: string;
let rawHash: string;
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
test.beforeAll(async () => {
  if (!process.env.DATABASE_URL || !process.env.DEV_UPLOAD_WORKSPACE_ID)
    throw Error(
      "Configure the local development metadata database for read-only preview E2E",
    );
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  const v = (
    await pool.query(
      `SELECT v.*,d.name FROM app.dataset_versions v JOIN app.datasets d ON d.id=v.dataset_id
    WHERE d.workspace_id=$1 AND v.status='READY' ORDER BY v.created_at DESC LIMIT 1`,
      [process.env.DEV_UPLOAD_WORKSPACE_ID],
    )
  ).rows[0];
  if (!v)
    throw Error(
      "A READY local CSV is required; E2E does not create or process product data",
    );
  datasetId = v.dataset_id;
  versionId = v.id;
  name = v.name;
  rowCount = v.row_count;
  columnCount = v.column_count;
  filename = path.resolve(
    process.env.LOCAL_STORAGE_ROOT || ".local/raw-storage",
    v.storage_key,
  );
  before = await snapshot();
  rawHash = createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
});
test.afterAll(async () => {
  try {
    if (before) {
      expect(await snapshot()).toBe(before);
      expect(
        createHash("sha256")
          .update(await readFile(filename))
          .digest("hex"),
      ).toBe(rawHash);
    }
  } finally {
    await pool?.end();
  }
});
test("real READY dataset: navigation, schema, preview and no hydration errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/data");
  await page.getByRole("link", { name, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/data/datasets/${datasetId}`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^READY$/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Schema do dataset" }).locator("tbody tr"),
  ).toHaveCount(columnCount);
  await expect(
    page.getByRole("region", { name: "Linhas do preview" }).locator("tbody tr"),
  ).toHaveCount(Math.min(50, Number(rowCount)));
  await expect(
    page.getByText("Desconhecido", { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/dataset-preview.png",
    fullPage: true,
  });
});
test("direct version URL renders without JavaScript", async ({
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
    // Streaming Suspense replacement requires JS. With JS off the metadata remains useful;
    // preview is verified with the normal browser above.
    await expect(
      page.getByRole("heading", { name, exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("READY", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
test("missing/invalid version returns actual HTTP 404", async ({ request }) => {
  for (const url of [
    "/data/datasets/invalid",
    `/data/datasets/${datasetId}?version=11111111-1111-4111-8111-111111111111`,
  ]) {
    const response = await request.get(url);
    expect(response.status()).toBe(404);
  }
});
