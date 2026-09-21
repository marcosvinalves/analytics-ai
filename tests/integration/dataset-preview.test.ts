import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { testDatabaseUrl } from "./helpers/database.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { getDatasetDetail } from "../../src/modules/dataset/application/get-dataset-detail.ts";
import {
  readDatasetMetadata,
  listDatasets,
} from "../../src/modules/dataset/infrastructure/read-dataset-metadata.ts";
import { readDatasetPreview } from "../../src/modules/dataset/infrastructure/read-dataset-preview.ts";
vi.mock("server-only", () => ({}));

let pool: Pool;
let root: string;
let org: string;
let workspaceId: string;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "preview-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  org = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Preview test') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Preview test') RETURNING id",
      [org],
    )
  ).rows[0].id;
});
afterAll(async () => {
  try {
    await pool.query(
      "DELETE FROM app.dataset_columns WHERE dataset_version_id IN (SELECT v.id FROM app.dataset_versions v JOIN app.datasets d ON d.id=v.dataset_id WHERE d.workspace_id=$1)",
      [workspaceId],
    );
    await pool.query(
      "DELETE FROM app.dataset_versions WHERE dataset_id IN (SELECT id FROM app.datasets WHERE workspace_id=$1)",
      [workspaceId],
    );
    await pool.query("DELETE FROM app.datasets WHERE workspace_id=$1", [
      workspaceId,
    ]);
    await pool.query("DELETE FROM app.workspaces WHERE id=$1", [workspaceId]);
    await pool.query("DELETE FROM app.organizations WHERE id=$1", [org]);
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

async function fixture(
  csv: string,
  columns: [string, string][],
  status = "READY",
  rows = "1",
) {
  const datasetId = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id,name,description) VALUES ($1,'Preview dataset','Read only') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id;
  const versionId = randomUUID();
  const key = rawStorageKey(workspaceId, versionId);
  const filename = path.join(root, key);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, csv);
  await pool.query(
    `INSERT INTO app.dataset_versions(id,dataset_id,version_number,source_type,storage_namespace,storage_key,status,row_count,column_count,processed_at,processing_error_code,original_filename,size_bytes)
    VALUES ($1,$2,1,'CSV','raw',$3,$4,$5,$6,CASE WHEN $4='PROCESSING' THEN NULL ELSE statement_timestamp() END,CASE WHEN $4='FAILED' THEN 'CSV_READ_FAILED' ELSE NULL END,'test.csv',$7)`,
    [
      versionId,
      datasetId,
      key,
      status,
      status === "READY" ? rows : null,
      status === "READY" ? columns.length : null,
      Buffer.byteLength(csv),
    ],
  );
  // Insert backwards to prove metadata ordering, not insertion order.
  if (status === "READY")
    for (let i = columns.length - 1; i >= 0; i--)
      await pool.query(
        "INSERT INTO app.dataset_columns(dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count) VALUES ($1,$2,$3,$4,NULL,0)",
        [versionId, ...columns[i], i + 1],
      );
  return { scope: { workspaceId, datasetId, versionId }, filename };
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function snapshot() {
  const tables = [
    "organizations",
    "workspaces",
    "datasets",
    "dataset_versions",
    "dataset_columns",
  ];
  return JSON.stringify(
    await Promise.all(
      tables.map(
        async (table) =>
          (await pool.query(`SELECT * FROM app.${table} ORDER BY id`)).rows,
      ),
    ),
  );
}

test("READY: precise typed text, ordered named cells, NULL and UTF-8; zero metadata/raw writes", async () => {
  const f = await fixture(
    'big,money,floating,day,moment,empty,text,flag\n9007199254740993,1234567890123456.78,0.1,2026-09-21,2026-09-21 12:34:56.123456,,"São Paulo, ação",true\n',
    [
      ["big", "BIGINT"],
      ["money", "DECIMAL(20,2)"],
      ["floating", "DOUBLE"],
      ["day", "DATE"],
      ["moment", "TIMESTAMP"],
      ["empty", "VARCHAR"],
      ["text", "VARCHAR"],
      ["flag", "BOOLEAN"],
    ],
  );
  const before = await snapshot(),
    raw = hash(await readFile(f.filename));
  const result = await getDatasetDetail(pool, f.scope);
  expect(result?.columns.map((c) => c.ordinalPosition)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(result?.preview).toEqual({
    state: "AVAILABLE",
    limit: 50,
    rows: [
      [
        { column: "big", value: "9007199254740993" },
        { column: "money", value: "1234567890123456.78" },
        { column: "floating", value: "0.1" },
        { column: "day", value: "2026-09-21" },
        { column: "moment", value: "2026-09-21 12:34:56.123456" },
        { column: "empty", value: null },
        { column: "text", value: "São Paulo, ação" },
        { column: "flag", value: "true" },
      ],
    ],
  });
  expect(() => JSON.stringify(result)).not.toThrow();
  expect(await snapshot()).toBe(before);
  expect(hash(await readFile(f.filename))).toBe(raw);
});
test("limit 50 is enforced in query", async () => {
  const f = await fixture(
    "id\n" + Array.from({ length: 65 }, (_, i) => `${i}\n`).join(""),
    [["id", "BIGINT"]],
    "READY",
    "65",
  );
  const result = await getDatasetDetail(pool, f.scope);
  expect(result?.preview.state).toBe("AVAILABLE");
  if (result?.preview.state === "AVAILABLE")
    expect(result.preview.rows).toHaveLength(50);
});
test.each(["PROCESSING", "FAILED"])("%s never reads raw", async (status) => {
  const f = await fixture("id\n1\n", [["id", "BIGINT"]], status);
  await rm(f.filename);
  expect((await getDatasetDetail(pool, f.scope))?.preview).toEqual({
    state: "UNAVAILABLE",
  });
});
test("NOT_FOUND for invalid scope, another workspace/dataset/version", async () => {
  const f = await fixture("id\n1\n", [["id", "BIGINT"]]);
  for (const scope of [
    { ...f.scope, workspaceId: randomUUID() },
    { ...f.scope, datasetId: randomUUID() },
    { ...f.scope, versionId: randomUUID() },
    { ...f.scope, datasetId: "invalid" },
  ])
    expect(await getDatasetDetail(pool, scope)).toBeNull();
});
test.each(["header", "type", "width", "missing", "path", "unknown-type"])(
  "integrity/read error %s leaves READY and schema unchanged",
  async (kind) => {
    const f = await fixture("id\n1\n", [["id", "BIGINT"]]);
    if (kind === "header") await writeFile(f.filename, "xx\n1\n");
    if (kind === "type") await writeFile(f.filename, "id\nx\n");
    if (kind === "width") await writeFile(f.filename, "id\n1,2\n");
    if (kind === "missing") await rm(f.filename);
    const meta = (await readDatasetMetadata(pool, f.scope))!;
    if (kind === "path") meta.raw.key = "../private";
    if (kind === "unknown-type")
      meta.detail.columns[0].inferredType = "BIGINT); DROP TABLE x; --";
    // Bypass size check only for type/width cases to test the strict reader itself.
    if (kind === "width") meta.raw.sizeBytes = null;
    const before = await snapshot();
    const preview = await readDatasetPreview(meta);
    expect(preview).toMatchObject({
      state: "ERROR",
      code: "PREVIEW_READ_FAILED",
    });
    expect(JSON.stringify(preview)).not.toContain(root);
    expect(await snapshot()).toBe(before);
  },
);
test("header-only CSV is empty, normalized/quoted headers are preserved", async () => {
  const empty = await fixture("id\n", [["id", "BIGINT"]], "READY", "0");
  expect((await getDatasetDetail(pool, empty.scope))?.preview).toEqual({
    state: "AVAILABLE",
    rows: [],
    limit: 50,
  });
  const named = await fixture('name,name,,"say""hi"\na,b,c,d\n', [
    ["name", "VARCHAR"],
    ["name_1", "VARCHAR"],
    ["column2", "VARCHAR"],
    ['say"hi', "VARCHAR"],
  ]);
  expect((await getDatasetDetail(pool, named.scope))?.preview).toMatchObject({
    state: "AVAILABLE",
    rows: [
      [
        { column: "name", value: "a" },
        { column: "name_1", value: "b" },
        { column: "column2", value: "c" },
        { column: 'say"hi', value: "d" },
      ],
    ],
  });
});

test("header whitespace and duplicate suffixes follow persisted physical names", async () => {
  const f = await fixture(" name ,name,name_1\na,b,c\n", [
    ["name", "VARCHAR"],
    ["name_1", "VARCHAR"],
    ["name_1_1", "VARCHAR"],
  ]);
  expect((await getDatasetDetail(pool, f.scope))?.preview).toMatchObject({
    state: "AVAILABLE",
  });
});
test("junction cannot redirect the raw object", async () => {
  const f = await fixture("id\n1\n", [["id", "BIGINT"]]);
  const linkId = randomUUID();
  const key = rawStorageKey(workspaceId, linkId);
  await symlink(
    path.dirname(f.filename),
    path.dirname(path.join(root, key)),
    "junction",
  );
  const metadata = (await readDatasetMetadata(pool, f.scope))!;
  metadata.raw.key = key;
  expect(await readDatasetPreview(metadata)).toMatchObject({ state: "ERROR" });
});
test("TIMESTAMPTZ uses UTC and DOUBLE special values remain explicit text", async () => {
  const f = await fixture(
    "instant,nan,infinity\n2026-09-21 12:34:56.123456-03,NaN,Infinity\n",
    [
      ["instant", "TIMESTAMP WITH TIME ZONE"],
      ["nan", "DOUBLE"],
      ["infinity", "DOUBLE"],
    ],
  );
  expect((await getDatasetDetail(pool, f.scope))?.preview).toEqual({
    state: "AVAILABLE",
    limit: 50,
    rows: [
      [
        { column: "instant", value: "2026-09-21 15:34:56.123456+00" },
        { column: "nan", value: "nan" },
        { column: "infinity", value: "inf" },
      ],
    ],
  });
});
test("default selection uses latest version, explicit older version stays selected", async () => {
  const f = await fixture("id\n1\n", [["id", "BIGINT"]]);
  await pool.query(
    "INSERT INTO app.dataset_versions(dataset_id,version_number,source_type,storage_namespace,storage_key) VALUES ($1,2,'CSV','raw',$2)",
    [f.scope.datasetId, rawStorageKey(workspaceId, randomUUID())],
  );
  const latest = await getDatasetDetail(pool, {
    workspaceId,
    datasetId: f.scope.datasetId,
  });
  expect(latest?.version).toMatchObject({
    versionNumber: 2,
    status: "PROCESSING",
  });
  expect((await getDatasetDetail(pool, f.scope))?.version.versionNumber).toBe(
    1,
  );
  expect(
    (await listDatasets(pool, workspaceId)).find(
      (d) => d.id === f.scope.datasetId,
    )?.versionNumber,
  ).toBe(2);
  expect(await listDatasets(pool, randomUUID())).toEqual([]);
});
