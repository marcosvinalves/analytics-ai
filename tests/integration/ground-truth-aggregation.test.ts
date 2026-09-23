import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { runGroundTruthAggregation } from "../../src/modules/dataset/application/run-ground-truth-aggregation.ts";
import { testDatabaseUrl } from "./helpers/database.ts";
vi.mock("server-only", () => ({}));

let pool: Pool;
let root: string;
let organizationId: string;
let workspaceId: string;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "ground-truth-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Ground truth') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Ground truth') RETURNING id",
      [organizationId],
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
    await pool.query("DELETE FROM app.organizations WHERE id=$1", [
      organizationId,
    ]);
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

async function fixture(
  options: {
    csv?: string;
    status?: "READY" | "PROCESSING" | "FAILED";
    columns?: [string, string][];
    rowCount?: number;
  } = {},
) {
  const csv = options.csv ?? "quantidade,preco_unitario\n2,0.10\n";
  const status = options.status ?? "READY";
  const columns = options.columns ?? [
    ["quantidade", "BIGINT"],
    ["preco_unitario", "DOUBLE"],
  ];
  const datasetId = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,'Ground truth') RETURNING id",
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
    VALUES($1,$2,1,'CSV','raw',$3,$4,$5,$6,CASE WHEN $4='PROCESSING' THEN NULL ELSE statement_timestamp() END,CASE WHEN $4='FAILED' THEN 'CSV_READ_FAILED' ELSE NULL END,'ground.csv',$7)`,
    [
      versionId,
      datasetId,
      key,
      status,
      status === "READY"
        ? (options.rowCount ??
          Math.max(0, csv.trimEnd().split("\n").length - 1))
        : null,
      status === "READY" ? columns.length : null,
      Buffer.byteLength(csv),
    ],
  );
  if (status === "READY")
    for (let index = 0; index < columns.length; index++)
      await pool.query(
        "INSERT INTO app.dataset_columns(dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count) VALUES($1,$2,$3,$4,NULL,0)",
        [versionId, ...columns[index], index + 1],
      );
  return {
    versionId,
    datasetId,
    filename,
    input: { workspaceId, datasetVersionId: versionId },
  };
}
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
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

test("synthetic fixture returns independent exact expected and observed DuckDB types", async () => {
  const csv = await readFile(
    "tests/fixtures/ground-truth/synthetic.csv",
    "utf8",
  );
  const expected = JSON.parse(
    await readFile("tests/fixtures/ground-truth/expected.json", "utf8"),
  );
  const f = await fixture({
    csv,
    columns: [
      ["quantidade", "BIGINT"],
      ["preco_unitario", "DOUBLE"],
      ["observacao", "VARCHAR"],
    ],
    rowCount: 7,
  });
  const before = await snapshot(),
    raw = digest(await readFile(f.filename));
  expect(await runGroundTruthAggregation(pool, f.input)).toEqual({
    outcome: "SUCCESS",
    value: expected.expectedValue,
    type: "DECIMAL(38,2)",
    rowCount: expected.rowCount,
    contributingRows: expected.contributingRows,
  });
  expect(await snapshot()).toBe(before);
  expect(digest(await readFile(f.filename))).toBe(raw);
});
test("0.10 + 0.20 is exact, zero/negative supported and no contributors differs from zero", async () => {
  const decimal = await fixture({
    csv: "quantidade,preco_unitario\n1,0.10\n1,0.20\n-2,0.15\n0,99.99\n",
  });
  expect(await runGroundTruthAggregation(pool, decimal.input)).toMatchObject({
    outcome: "SUCCESS",
    value: "0.00",
    contributingRows: "4",
  });
  const none = await fixture({
    csv: "quantidade,preco_unitario\n,1.00\n5,\n",
    rowCount: 2,
  });
  expect(await runGroundTruthAggregation(pool, none.input)).toMatchObject({
    outcome: "SUCCESS",
    value: null,
    contributingRows: "0",
  });
  const empty = await fixture({
    csv: "quantidade,preco_unitario\n",
    rowCount: 0,
  });
  expect(await runGroundTruthAggregation(pool, empty.input)).toMatchObject({
    outcome: "SUCCESS",
    value: null,
    rowCount: "0",
  });
});
test.each(["PROCESSING", "FAILED"] as const)(
  "%s returns NOT_READY without reading raw",
  async (status) => {
    const f = await fixture({ status });
    await rm(f.filename);
    expect(await runGroundTruthAggregation(pool, f.input)).toEqual({
      outcome: "NOT_READY",
      status,
    });
  },
);
test("not found for missing, wrong workspace and invalid IDs", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, datasetVersionId: randomUUID() },
    { ...f.input, workspaceId: randomUUID() },
    { ...f.input, datasetVersionId: "invalid" },
  ])
    expect(await runGroundTruthAggregation(pool, input)).toEqual({
      outcome: "NOT_FOUND",
    });
});
test("PostgreSQL unavailable returns a safe operational error", async () => {
  const unavailable = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await unavailable.end();
  const result = await runGroundTruthAggregation(unavailable, {
    workspaceId,
    datasetVersionId: randomUUID(),
  });
  expect(result).toMatchObject({
    outcome: "ERROR",
    code: "GROUND_TRUTH_OPERATIONAL_FAILURE",
  });
  expect(JSON.stringify(result)).not.toMatch(
    /postgresql|password|stack|SELECT/i,
  );
});
const invalidSchemas: { columns: [string, string][] }[] = [
  { columns: [["preco_unitario", "DOUBLE"]] },
  { columns: [["quantidade", "BIGINT"]] },
  {
    columns: [
      ["quantidade", "VARCHAR"],
      ["preco_unitario", "DOUBLE"],
    ],
  },
];
test.each(invalidSchemas)(
  "missing/non-numeric required persisted schema is safe",
  async ({ columns }) => {
    const f = await fixture({ columns });
    expect(await runGroundTruthAggregation(pool, f.input)).toMatchObject({
      outcome: "ERROR",
      code: "GROUND_TRUTH_SCHEMA_INVALID",
    });
  },
);
test.each([
  ["quantidade,preco_unitario\n1.5,2.00\n", "GROUND_TRUTH_INPUT_INVALID"],
  ["quantidade,preco_unitario\n1,2.001\n", "GROUND_TRUTH_INPUT_INVALID"],
  ["quantidade,preco_unitario\n1e2,2.00\n", "GROUND_TRUTH_INPUT_INVALID"],
  ["quantidade,preco_unitario\ninvalid,\n", "GROUND_TRUTH_INPUT_INVALID"],
  [
    "quantidade,preco_unitario\n999999999999999999,1.00\n",
    "GROUND_TRUTH_OVERFLOW",
  ],
] as const)("invalid/overflow input returns %s", async (csv, code) => {
  const columns: [string, string][] =
    code === "GROUND_TRUTH_OVERFLOW"
      ? [
          ["quantidade", "DECIMAL(18,0)"],
          ["preco_unitario", "DECIMAL(18,2)"],
        ]
      : [
          ["quantidade", "DOUBLE"],
          ["preco_unitario", "DOUBLE"],
        ];
  const f = await fixture({ csv, columns });
  const before = await snapshot();
  expect(await runGroundTruthAggregation(pool, f.input)).toMatchObject({
    outcome: "ERROR",
    code,
  });
  expect(await snapshot()).toBe(before);
});
test.each(["missing", "header", "width", "value", "path"])(
  "raw/schema incompatibility %s is read error and stays READY",
  async (kind) => {
    const f = await fixture();
    if (kind === "missing") await rm(f.filename);
    if (kind === "header") await writeFile(f.filename, "q,p\n2,0.10\n");
    if (kind === "width")
      await writeFile(f.filename, "quantidade,preco_unitario\n2,0.10,extra\n");
    if (kind === "value")
      await writeFile(f.filename, "quantidade,preco_unitario\nnot-int,0.10\n");
    if (kind === "path")
      await pool.query(
        "UPDATE app.dataset_versions SET storage_key='../private.csv' WHERE id=$1",
        [f.versionId],
      );
    if (kind !== "missing")
      await pool.query(
        "UPDATE app.dataset_versions SET size_bytes=$2 WHERE id=$1",
        [f.versionId, (await readFile(f.filename)).length],
      );
    const before = await snapshot();
    const result = await runGroundTruthAggregation(pool, f.input);
    expect(result).toMatchObject({
      outcome: "ERROR",
      code:
        kind === "value"
          ? "GROUND_TRUTH_INPUT_INVALID"
          : "GROUND_TRUTH_READ_FAILED",
    });
    expect(await snapshot()).toBe(before);
    expect(
      (
        await pool.query(
          "SELECT status FROM app.dataset_versions WHERE id=$1",
          [f.versionId],
        )
      ).rows[0].status,
    ).toBe("READY");
  },
);
