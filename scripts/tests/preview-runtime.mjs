// Minimal Next harness, generated locally because product preview is disabled in production.
// Imports the permanent readDatasetPreview; no copied application or preview implementation.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const cli = path.join(root, "node_modules", "next", "dist", "bin", "next");
// Exercise the real build first. Never override the product's dev-only gate.
await readFile(path.join(root, ".next", "BUILD_ID"));
const product = spawn(
  process.execPath,
  [cli, "start", "--hostname", "127.0.0.1", "--port", "3010"],
  {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
    windowsHide: true,
  },
);
try {
  for (const route of [
    "/data",
    "/data/datasets/11111111-1111-4111-8111-111111111111",
  ]) {
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (product.exitCode !== null) throw Error("Product runtime exited");
      try {
        response = await fetch(`http://127.0.0.1:3010${route}`, {
          signal: AbortSignal.timeout(20000),
        });
        break;
      } catch {
        await delay(100);
      }
    }
    assert.equal(
      response?.status,
      404,
      "Product preview must remain unavailable in production",
    );
  }
  console.log(
    "PASS: real product build serves HTTP 404 for local-only preview; no production bypass.",
  );
} finally {
  if (product.exitCode === null) {
    product.kill();
    await once(product, "exit");
  }
}
await mkdir(path.join(root, ".local"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".local", "preview-runtime-"));
const filename = path.join(
  directory,
  "raw",
  "workspaces",
  "11111111-1111-4111-8111-111111111111",
  "versions",
  "22222222-2222-4222-8222-222222222222",
  "raw.csv",
);
await mkdir(path.dirname(filename), { recursive: true });
await mkdir(path.join(directory, "app"), { recursive: true });
const csv = "id,money,day\n9007199254740993,1234567890123456.78,2026-09-21\n";
await writeFile(filename, csv);
await writeFile(
  path.join(directory, "app", "route.js"),
  `import { readDatasetPreview } from '../../../src/modules/dataset/infrastructure/read-dataset-preview.ts';
export const runtime='nodejs'; export const dynamic='force-dynamic';
export async function GET() {
  if(process.env.PREVIEW_RUNTIME_TEST !== 'true') return new Response(null,{status:404});
  const result = await readDatasetPreview(JSON.parse(process.env.PREVIEW_TEST_METADATA));
  return Response.json(result);
}`,
);
await writeFile(
  path.join(directory, "next.config.mjs"),
  `import config from '../../next.config.ts';
export default {...config, turbopack:{root:${JSON.stringify(root)}}};`,
);
const columns = [
  ["id", "BIGINT"],
  ["money", "DECIMAL(20,2)"],
  ["day", "DATE"],
].map(([physicalName, inferredType], i) => ({
  physicalName,
  inferredType,
  ordinalPosition: i + 1,
  nullable: null,
  nullCount: "0",
}));
const env = {
  ...process.env,
  NODE_ENV: "production",
  PREVIEW_RUNTIME_TEST: "true",
  LOCAL_STORAGE_ROOT: path.join(directory, "raw"),
  PREVIEW_TEST_METADATA: JSON.stringify({
    detail: { version: { status: "READY", columnCount: 3 }, columns },
    raw: {
      namespace: "raw",
      key: "workspaces/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/raw.csv",
      sizeBytes: String(Buffer.byteLength(csv)),
      sourceType: "CSV",
    },
  }),
};
delete env.DATABASE_URL;
const build = spawn(process.execPath, [cli, "build", directory], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: true,
});
assert.equal((await once(build, "exit"))[0], 0, "Harness build");
const server = spawn(
  process.execPath,
  [cli, "start", directory, "--hostname", "127.0.0.1", "--port", "3011"],
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error("Runtime server exited");
    try {
      response = await fetch("http://127.0.0.1:3011", {
        signal: AbortSignal.timeout(20000),
      });
      break;
    } catch {
      await delay(100);
    }
  }
  assert(response?.ok, "Runtime HTTP response");
  const result = await response.json();
  assert.deepEqual(result, {
    state: "AVAILABLE",
    limit: 50,
    rows: [
      [
        { column: "id", value: "9007199254740993" },
        { column: "money", value: "1234567890123456.78" },
        { column: "day", value: "2026-09-21" },
      ],
    ],
  });
  assert.equal(
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex"),
    createHash("sha256").update(csv).digest("hex"),
  );
  console.log(
    "PASS: compiled Next runtime loaded native binding and executed permanent readDatasetPreview; BIGINT/DECIMAL/DATE exact; raw unchanged; no PostgreSQL connection.",
  );
} finally {
  if (server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  // Only generated disposable harness files beneath this fixed .local directory.
  await rm(directory, { recursive: true, force: true });
}
