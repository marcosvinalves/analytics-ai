import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { testDatabaseUrl } from "./helpers/database.ts";

let server: ChildProcess;
let pool: Pool;
let root: string;
let origin: string;
let workspaceId: string;
let organizationId: string;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "upload-http-"));
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations (name) VALUES ('HTTP Test') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces (organization_id, name) VALUES ($1, 'Test') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: testDatabaseUrl(),
        ENABLE_LOCAL_UPLOAD: "true",
        DEV_UPLOAD_WORKSPACE_ID: workspaceId,
        LOCAL_UPLOAD_ORIGIN: origin,
        LOCAL_STORAGE_ROOT: root,
        MAX_UPLOAD_BYTES: "100",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Next dev startup timeout")),
      60000,
    );
    server.stdout?.on("data", (data) => {
      if (data.toString().includes("Ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr?.on("data", () => {});
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Next dev exited"));
    });
  });
}, 70000);
afterAll(async () => {
  if (server?.exitCode === null) {
    // Next dev has a child worker on Windows. Stop only this spawned process tree.
    await new Promise<void>((resolve) => {
      if (process.platform === "win32") {
        const stop = spawn(
          "taskkill",
          ["/PID", String(server.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        stop.once("close", () => resolve());
      } else {
        server.once("close", () => resolve());
        server.kill("SIGTERM");
      }
    });
  }
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
}, 20000);

function endpoint() {
  return `${origin}/api/workspaces/${workspaceId}/datasets`;
}
function form(bytes = "quantity,price\n2,10\n", filename = "vendas.csv") {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type: "text/csv" }), filename);
  body.append("name", "Receita HTTP");
  return body;
}
test("GET /data/upload e POST real persistem arquivo, Dataset e versão PROCESSING/CSV sem colunas", async () => {
  const page = await fetch(`${origin}/data/upload`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('type="file"');
  expect(html).toContain("Enviar CSV");
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: { Origin: origin },
    body: form(),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(201);
  expect(result.dataset.name).toBe("Receita HTTP");
  expect(result.version).toMatchObject({
    originalFilename: "vendas.csv",
    sizeBytes: 20,
    sourceType: "CSV",
    status: "PROCESSING",
  });
  expect(JSON.stringify(result)).not.toContain(root);
  expect(result.version.storageKey).toBeUndefined();
  const row = (
    await pool.query(
      "SELECT v.*, d.workspace_id FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id WHERE v.id = $1",
      [result.version.id],
    )
  ).rows[0];
  expect(row).toMatchObject({
    dataset_id: result.dataset.id,
    workspace_id: workspaceId,
    status: "PROCESSING",
    source_type: "CSV",
    row_count: null,
    column_count: null,
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
}, 60000);
test("HTTP rejeita origem, workspace, arquivo grande e identificadores controlados pelo cliente", async () => {
  expect(
    (
      await fetch(endpoint(), {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: form(),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(
        endpoint().replace(workspaceId, "00000000-0000-4000-8000-000000000000"),
        { method: "POST", headers: { Origin: origin }, body: form() },
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(endpoint(), {
        method: "POST",
        headers: { Origin: origin },
        body: form("x".repeat(101)),
      })
    ).status,
  ).toBe(413);
  const invalid = form();
  invalid.append("datasetId", "client-chosen");
  expect(
    (
      await fetch(endpoint(), {
        method: "POST",
        headers: { Origin: origin },
        body: invalid,
      })
    ).status,
  ).toBe(400);
});
