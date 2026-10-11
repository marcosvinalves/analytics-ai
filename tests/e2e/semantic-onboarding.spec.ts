import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
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

async function sha256(filename: string) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function upload(page: Page, name: string, fixture: string) {
  await page.goto("/data/upload");
  await page.getByLabel("Nome do dataset").fill(name);
  await page.getByLabel("Arquivo CSV").setInputFiles(fixture);
  await page.getByRole("button", { name: "Enviar CSV" }).click();
  await expect(
    page.getByRole("status", { name: "Upload concluído" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Abrir dataset" }).click();
}

test.beforeAll(async () => {
  await resetTestDatabase();
  await rm(storageRoot, { recursive: true, force: true });
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await pool.query(
    "INSERT INTO app.organizations(id,name) VALUES($1,'Onboarding E2E')",
    [organizationId],
  );
  await pool.query(
    `INSERT INTO app.workspaces(id,organization_id,name)
     VALUES($1,$3,'Onboarding E2E'),($2,$3,'Other workspace')`,
    [workspaceId, otherWorkspaceId, organizationId],
  );
  otherDatasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,'Private semantic dataset') RETURNING id",
      [otherWorkspaceId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key)
     VALUES($1,$2,1,'CSV','raw',$3)`,
    [randomUUID(), otherDatasetId, `private/${randomUUID()}/raw.csv`],
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

test("upload, processamento e criação explícita reutilizam um único draft", async ({
  page,
}) => {
  const errors = browserErrors(page);
  await upload(
    page,
    "Semantic onboarding E2E",
    path.resolve("tests/fixtures/dataset-processing/valid.csv"),
  );
  await expect(
    page.locator("dd").filter({ hasText: /^PROCESSING$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preparar análise" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Processar dados" }).click();
  await expect(page.locator("dd").filter({ hasText: /^READY$/ })).toBeVisible();

  const version = (
    await pool.query(
      `SELECT v.*,d.id AS dataset_id FROM app.dataset_versions v
       JOIN app.datasets d ON d.id=v.dataset_id
       WHERE d.workspace_id=$1 AND d.name='Semantic onboarding E2E'`,
      [workspaceId],
    )
  ).rows[0];
  const rawPath = path.join(storageRoot, version.storage_key);
  const rawBefore = await sha256(rawPath);
  const versionBefore = JSON.stringify(version);

  await page.getByRole("button", { name: "Preparar análise" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/data/datasets/${version.dataset_id}/semantic\\?version=${version.id}`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: "Preparação da análise" }),
  ).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^DRAFT$/ })).toBeVisible();
  await expect(page.getByText("Versão 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Revisar campos" }),
  ).toBeVisible();
  await expect(page.getByText("0 de 7 incluídos")).toBeVisible();

  const quantity = page.locator("article").filter({
    has: page.getByRole("heading", { name: "quantidade", exact: true }),
  });
  await quantity.getByRole("button", { name: "Incluir campo" }).click();
  await expect(page.getByText("1 de 7 incluídos")).toBeVisible();
  const originalQuantity = (
    await pool.query<{ id: string; field_key: string }>(
      `SELECT f.id,f.field_key FROM app.semantic_fields f
       JOIN app.semantic_model_revisions r ON r.id=f.semantic_model_revision_id
       JOIN app.semantic_models m ON m.id=r.semantic_model_id
       WHERE m.dataset_id=$1 AND f.name='quantidade'`,
      [version.dataset_id],
    )
  ).rows[0];

  await quantity.getByLabel("Label").fill("Quantidade vendida");
  await quantity.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(quantity.getByText("Campo atualizado.")).toBeVisible();
  expect(
    (
      await pool.query<{ id: string; field_key: string }>(
        "SELECT id,field_key FROM app.semantic_fields WHERE id=$1",
        [originalQuantity.id],
      )
    ).rows[0],
  ).toEqual(originalQuantity);

  await quantity.getByRole("button", { name: "Remover campo" }).click();
  await quantity.getByRole("button", { name: "Confirmar remoção" }).click();
  await expect(page.getByText("0 de 7 incluídos")).toBeVisible();
  await quantity.getByRole("button", { name: "Incluir campo" }).click();
  await expect(page.getByText("1 de 7 incluídos")).toBeVisible();
  const recreatedQuantity = (
    await pool.query<{ id: string; field_key: string }>(
      `SELECT f.id,f.field_key FROM app.semantic_fields f
       JOIN app.semantic_model_revisions r ON r.id=f.semantic_model_revision_id
       JOIN app.semantic_models m ON m.id=r.semantic_model_id
       WHERE m.dataset_id=$1 AND f.name='quantidade'`,
      [version.dataset_id],
    )
  ).rows[0];
  expect(recreatedQuantity.id).not.toBe(originalQuantity.id);
  expect(recreatedQuantity.field_key).not.toBe(originalQuantity.field_key);

  const price = page.locator("article").filter({
    has: page.getByRole("heading", { name: "preco_unitario", exact: true }),
  });
  await price.getByLabel("Tipo semântico").selectOption("DECIMAL");
  await price.getByLabel("Precision").fill("18");
  await price.getByLabel("Scale").fill("2");
  await expect(price.getByText(/Conversão explícita/)).toBeVisible();
  await expect(
    price.getByRole("button", { name: "Incluir campo" }),
  ).toBeDisabled();
  await price.getByRole("checkbox").check();
  await price.getByLabel("Scale").fill("3");
  await expect(price.getByRole("checkbox")).not.toBeChecked();
  await expect(
    price.getByRole("button", { name: "Incluir campo" }),
  ).toBeDisabled();
  await price.getByRole("checkbox").check();
  await price.getByRole("button", { name: "Incluir campo" }).click();
  await expect(page.getByText("2 de 7 incluídos")).toBeVisible();

  const priceField = (
    await pool.query<{ field_key: string; revision_id: string }>(
      `SELECT f.field_key,f.semantic_model_revision_id AS revision_id
       FROM app.semantic_fields f
       JOIN app.semantic_model_revisions r ON r.id=f.semantic_model_revision_id
       JOIN app.semantic_models m ON m.id=r.semantic_model_id
       WHERE m.dataset_id=$1 AND f.name='preco_unitario'`,
      [version.dataset_id],
    )
  ).rows[0];
  const priceMetric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: priceField.revision_id,
    name: "total_price",
    label: "Preço total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: priceField.field_key },
    },
  });
  expect(priceMetric.outcome).toBe("CREATED");

  const saleDate = page.locator("article").filter({
    has: page.getByRole("heading", { name: "data", exact: true }),
  });
  await saleDate.getByLabel("Tipo semântico").selectOption("DATETIME");
  await expect(saleDate.getByRole("alert")).toContainText("incompatível");
  await expect(
    saleDate.getByRole("button", { name: "Incluir campo" }),
  ).toBeDisabled();

  await page.reload();
  await expect(page.locator("dd").filter({ hasText: /^DRAFT$/ })).toBeVisible();
  await expect(page.getByText("2 de 7 incluídos")).toBeVisible();
  const persistedPrice = page.locator("article").filter({
    has: page.getByRole("heading", { name: "preco_unitario", exact: true }),
  });
  await expect(
    persistedPrice.getByText("Uma métrica usa este campo"),
  ).toBeVisible();
  await expect(
    persistedPrice.getByRole("button", { name: "Remover campo" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Tipo semântico").first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("link", { name: "Voltar ao Dataset" }).click();
  await expect(
    page.getByRole("link", { name: "Continuar preparação" }),
  ).toBeVisible();

  const counts = await pool.query<{
    models: number;
    revisions: number;
    fields: number;
    metrics: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM app.semantic_models WHERE dataset_id=$1) AS models,
      (SELECT count(*)::int FROM app.semantic_model_revisions r JOIN app.semantic_models m ON m.id=r.semantic_model_id WHERE m.dataset_id=$1) AS revisions,
      (SELECT count(*)::int FROM app.semantic_fields f JOIN app.semantic_model_revisions r ON r.id=f.semantic_model_revision_id JOIN app.semantic_models m ON m.id=r.semantic_model_id WHERE m.dataset_id=$1) AS fields,
      (SELECT count(*)::int FROM app.metrics x JOIN app.semantic_model_revisions r ON r.id=x.semantic_model_revision_id JOIN app.semantic_models m ON m.id=r.semantic_model_id WHERE m.dataset_id=$1) AS metrics`,
    [version.dataset_id],
  );
  expect(counts.rows[0]).toEqual({
    models: 1,
    revisions: 1,
    fields: 2,
    metrics: 1,
  });
  expect(
    JSON.stringify(
      (
        await pool.query("SELECT * FROM app.dataset_versions WHERE id=$1", [
          version.id,
        ])
      ).rows[0],
    ),
  ).toBe(versionBefore);
  expect(await sha256(rawPath)).toBe(rawBefore);
  expect(errors).toEqual([]);
});

test("publicação existente é somente descoberta e não cria outro draft", async ({
  page,
}) => {
  const row = (
    await pool.query<{
      dataset_id: string;
      revision_id: string;
      column_id: string;
    }>(
      `SELECT d.id AS dataset_id,r.id AS revision_id,c.id AS column_id
       FROM app.datasets d
       JOIN app.semantic_models m ON m.dataset_id=d.id
       JOIN app.semantic_model_revisions r ON r.semantic_model_id=m.id
       JOIN app.dataset_versions v ON v.id=r.dataset_version_id
       JOIN app.dataset_columns c ON c.dataset_version_id=v.id
       WHERE d.name='Semantic onboarding E2E' AND c.physical_name='quantidade'`,
    )
  ).rows[0];
  const field = (
    await pool.query<{ field_key: string }>(
      `SELECT field_key FROM app.semantic_fields
       WHERE semantic_model_revision_id=$1 AND dataset_column_id=$2`,
      [row.revision_id, row.column_id],
    )
  ).rows[0];
  if (!field) throw new Error("Expected semantic field");
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: row.revision_id,
    name: "total_quantity",
    label: "Quantidade total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: field.field_key },
    },
  });
  if (metric.outcome !== "CREATED") throw new Error("Expected metric");
  expect(
    await publishSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: row.revision_id,
    }),
  ).toMatchObject({ outcome: "PUBLISHED" });

  await page.goto(`/data/datasets/${row.dataset_id}`);
  await expect(
    page
      .getByText("Este Dataset possui um modelo semântico publicado.")
      .first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Ver preparação" }).first().click();
  await expect(
    page.locator("dd").filter({ hasText: /^PUBLISHED$/ }),
  ).toBeVisible();
  await expect(page.getByText("Nenhum novo draft foi criado.")).toBeVisible();
  expect(
    (
      await pool.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM app.semantic_model_revisions WHERE semantic_model_id=(SELECT id FROM app.semantic_models WHERE dataset_id=$1)",
        [row.dataset_id],
      )
    ).rows[0].total,
  ).toBe(1);
});

test("falha determinística e cross-workspace permanecem seguros", async ({
  page,
  request,
}) => {
  await upload(
    page,
    "Semantic failed E2E",
    path.resolve("tests/fixtures/dataset-processing/invalid.csv"),
  );
  await page.getByRole("button", { name: "Processar dados" }).click();
  await expect(
    page.locator("dd").filter({ hasText: /^FAILED$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preparar análise" }),
  ).toHaveCount(0);
  expect(
    (await request.get(`/data/datasets/${otherDatasetId}/semantic`)).status(),
  ).toBe(404);
});
