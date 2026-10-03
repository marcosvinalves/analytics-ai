import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import {
  resolveAnalyticalSource,
  withAnalyticalMaterial,
} from "../../src/modules/dataset/application/resolve-analytical-source.ts";
import { testDatabaseUrl } from "./helpers/database.ts";

vi.mock("server-only", () => ({}));

let pool: Pool;
let root: string;
let organizationId: string;
let workspaceId: string;

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "analytical-source-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Analytical source') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Analytical source') RETURNING id",
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
    status?: "PROCESSING" | "READY" | "FAILED";
    sourceType?: string;
    inferredType?: string;
    createColumn?: boolean;
    csv?: string;
  } = {},
) {
  const status = options.status ?? "READY";
  const csv = options.csv ?? "value\n24.90\n";
  const datasetId = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,'Source') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id as string;
  const datasetVersionId = randomUUID();
  const key = rawStorageKey(workspaceId, datasetVersionId);
  const filename = path.join(root, key);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, csv);
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,status,row_count,column_count,processed_at,processing_error_code,original_filename,size_bytes)
     VALUES($1,$2,1,$3,'raw',$4,$5,$6,$7,
       CASE WHEN $5='PROCESSING' THEN NULL ELSE statement_timestamp() END,
       CASE WHEN $5='FAILED' THEN 'CSV_READ_FAILED' ELSE NULL END,
       'source.csv',$8)`,
    [
      datasetVersionId,
      datasetId,
      options.sourceType ?? "CSV",
      key,
      status,
      status === "READY" ? 1 : null,
      status === "READY" ? 1 : null,
      Buffer.byteLength(csv),
    ],
  );
  if (status === "READY" && options.createColumn !== false)
    await pool.query(
      `INSERT INTO app.dataset_columns
       (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
       VALUES($1,'value',$2,1,NULL,0)`,
      [datasetVersionId, options.inferredType ?? "DOUBLE"],
    );
  return {
    datasetId,
    datasetVersionId,
    filename,
    scope: { workspaceId, datasetId, datasetVersionId },
  };
}

function visibleStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(visibleStrings);
}

test("resolves READY CSV with schema and an opaque local material handle", async () => {
  const item = await fixture();
  const result = await resolveAnalyticalSource(pool, item.scope);
  expect(result.outcome).toBe("RESOLVED");
  if (result.outcome !== "RESOLVED") return;
  expect(result.source).toMatchObject({
    datasetId: item.datasetId,
    datasetVersionId: item.datasetVersionId,
    sourceType: "CSV",
    expectedRowCount: BigInt(1),
    schema: [
      {
        physicalName: "value",
        physicalType: { family: "NUMBER", name: "DOUBLE" },
        ordinalPosition: 1,
      },
    ],
  });
  expect(Reflect.ownKeys(result.source.material)).toEqual([]);
  expect(visibleStrings(result.source)).not.toContain(item.filename);
  expect(
    withAnalyticalMaterial(result.source.material, (filename) => filename),
  ).toBe(item.filename);
  expect(result.source.materialIdentity.sizeBytes).toBe(
    result.source.expectedSizeBytes,
  );
  expect(Object.isFrozen(result.source)).toBe(true);
});

test.each(["PROCESSING", "FAILED"] as const)(
  "%s returns NOT_READY before local material resolution",
  async (status) => {
    const item = await fixture({ status });
    await rm(item.filename);
    expect(await resolveAnalyticalSource(pool, item.scope)).toEqual({
      outcome: "NOT_READY",
      status,
    });
  },
);

test("wrong workspace, dataset/version mismatch and invalid IDs are NOT_FOUND", async () => {
  const item = await fixture();
  for (const scope of [
    { ...item.scope, workspaceId: randomUUID() },
    { ...item.scope, datasetId: randomUUID() },
    { ...item.scope, datasetVersionId: randomUUID() },
    { ...item.scope, datasetVersionId: "invalid" },
  ])
    expect(await resolveAnalyticalSource(pool, scope)).toEqual({
      outcome: "NOT_FOUND",
    });
});

test("rejects unsupported source before reading local material", async () => {
  const item = await fixture({ sourceType: "PARQUET" });
  await rm(item.filename);
  expect(await resolveAnalyticalSource(pool, item.scope)).toEqual({
    outcome: "UNSUPPORTED_SOURCE_TYPE",
  });
});

test("invalid persisted schema is SOURCE_INTEGRITY_FAILED", async () => {
  const missing = await fixture({ createColumn: false });
  expect(await resolveAnalyticalSource(pool, missing.scope)).toEqual({
    outcome: "SOURCE_INTEGRITY_FAILED",
  });
  const unsupported = await fixture({ inferredType: "CUSTOM" });
  expect(await resolveAnalyticalSource(pool, unsupported.scope)).toEqual({
    outcome: "SOURCE_INTEGRITY_FAILED",
  });
});

test("missing or size-changed raw is SOURCE_UNAVAILABLE without leaking location", async () => {
  const missing = await fixture();
  await rm(missing.filename);
  expect(await resolveAnalyticalSource(pool, missing.scope)).toEqual({
    outcome: "SOURCE_UNAVAILABLE",
  });
  const changed = await fixture();
  await writeFile(changed.filename, "value\n24.900\n");
  const result = await resolveAnalyticalSource(pool, changed.scope);
  expect(result).toEqual({ outcome: "SOURCE_UNAVAILABLE" });
  expect(visibleStrings(result)).not.toContain(changed.filename);
});

test("rejects a symlinked raw location", async () => {
  const item = await fixture();
  const versionDirectory = path.dirname(item.filename);
  const outside = await mkdtemp(path.join(os.tmpdir(), "analytical-outside-"));
  try {
    await rm(versionDirectory, { recursive: true, force: true });
    await writeFile(path.join(outside, "raw.csv"), "value\n24.90\n");
    await symlink(outside, versionDirectory, "junction");
    expect(await resolveAnalyticalSource(pool, item.scope)).toEqual({
      outcome: "SOURCE_UNAVAILABLE",
    });
  } finally {
    await rm(versionDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("PostgreSQL failure returns a safe operational outcome", async () => {
  const unavailable = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await unavailable.end();
  const result = await resolveAnalyticalSource(unavailable, {
    workspaceId,
    datasetId: randomUUID(),
    datasetVersionId: randomUUID(),
  });
  expect(result).toEqual({ outcome: "OPERATIONAL_FAILURE" });
  expect(visibleStrings(result).join(" ")).not.toMatch(
    /postgres|select|password|storage/i,
  );
});
