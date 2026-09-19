import { expect, test } from "@playwright/test";

const file = {
  name: "vendas_teste_analytics_ai.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("quantity,price\n2,10\n"),
};
const endpoint = /\/api\/workspaces\/[0-9a-f-]+\/datasets$/;

test("sem JavaScript, formulário não permite submit nativo", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/data/upload");
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
    await expect(page.getByLabel("Arquivo CSV")).toBeDisabled();
    expect(
      await page.locator("noscript").evaluate((node) => node.textContent),
    ).toContain("Ative o JavaScript");
    await expect(page.locator("form")).toHaveAttribute("method", "post");
    await expect(page.locator("form")).toHaveAttribute(
      "enctype",
      "multipart/form-data",
    );
    await expect(page).toHaveURL(/\/data\/upload$/);
  } finally {
    await context.close();
  }
});

test("submit hidratado envia multipart por fetch e mostra sucesso sem navegação", async ({
  page,
}) => {
  let uploadCount = 0;
  await page.route(endpoint, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.isNavigationRequest()).toBe(false);
    expect(request.headers()["content-type"]).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const multipart = await new Request(request.url(), {
      method: "POST",
      headers: { "content-type": request.headers()["content-type"] },
      body: new Uint8Array(request.postDataBuffer() ?? []),
    }).formData();
    expect([...multipart.keys()].sort()).toEqual(["file", "name"]);
    expect(multipart.get("name")).toBe("Vendas locais");
    const received = multipart.get("file") as File;
    expect(received.name).toBe(file.name);
    expect(await received.text()).toBe(file.buffer.toString());
    uploadCount++;
    await route.fulfill({
      status: 201,
      json: {
        dataset: { id: "dataset-test", name: "Vendas locais" },
        version: {
          id: "version-test",
          versionNumber: 1,
          status: "PROCESSING",
          originalFilename: file.name,
          sizeBytes: file.buffer.length,
        },
      },
    });
  });
  await page.goto("/data/upload");
  await expect(
    page.getByRole("button", { name: "Enviar CSV", exact: true }),
  ).toBeEnabled();
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.getByLabel("Nome do dataset").fill("Vendas locais");
  await page.getByLabel("Arquivo CSV").setInputFiles(file);
  await page.getByRole("button", { name: "Enviar CSV", exact: true }).click();
  const success = page.getByRole("status", { name: "Upload concluído" });
  await expect(success).toContainText("Dataset: Vendas locais");
  await expect(success).toContainText(`Arquivo: ${file.name}`);
  await expect(success).toContainText(`Tamanho: ${file.buffer.length} bytes`);
  await expect(success).toContainText("Número da versão: 1");
  await expect(success).toContainText("PROCESSING");
  await expect(page).toHaveURL(/\/data\/upload$/);
  expect(uploadCount).toBe(1);
  expect(navigations).toBe(0);
});

test("erro seguro aparece no formulário sem navegação", async ({ page }) => {
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "METADATA_WRITE_FAILED",
          message: "Não foi possível registrar o upload.",
        },
      },
    }),
  );
  await page.goto("/data/upload");
  await expect(
    page.getByRole("button", { name: "Enviar CSV", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Arquivo CSV").setInputFiles(file);
  await page.getByRole("button", { name: "Enviar CSV", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Não foi possível registrar o upload.",
  );
  await expect(page).toHaveURL(/\/data\/upload$/);
  await expect(
    page.getByRole("button", { name: "Enviar CSV", exact: true }),
  ).toBeEnabled();
});
