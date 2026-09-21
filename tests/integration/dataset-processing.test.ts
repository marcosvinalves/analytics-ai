import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, afterEach, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { testDatabaseUrl } from "./helpers/database.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { processDatasetVersion } from "../../src/modules/dataset/application/process-dataset-version.ts";
import { inspectCsv } from "../../src/modules/dataset/infrastructure/inspect-csv.ts";
import {
  loadVersion,
  persistDatasetProfile,
} from "../../src/modules/dataset/infrastructure/persist-dataset-profile.ts";
import {
  markDatasetVersionFailed,
  markDatasetVersionReady,
} from "../../src/modules/dataset/infrastructure/dataset-version-lifecycle.ts";
import type { DatasetProfile } from "../../src/modules/dataset/domain/dataset-profile.ts";

let pool: Pool;
let root: string;
let org: string;
let workspaceId: string;
let dataset: string;
let number = 0;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "dataset-processing-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  vi.stubEnv("MAX_UPLOAD_BYTES", "10485760");
  org = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Process test') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Process test') RETURNING id",
      [org],
    )
  ).rows[0].id;
  dataset = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,'Process test') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (dataset) {
      await pool.query(
        "DELETE FROM app.dataset_columns WHERE dataset_version_id IN (SELECT id FROM app.dataset_versions WHERE dataset_id=$1)",
        [dataset],
      );
      await pool.query("DELETE FROM app.dataset_versions WHERE dataset_id=$1", [
        dataset,
      ]);
      await pool.query("DELETE FROM app.datasets WHERE id=$1", [dataset]);
    }
    if (workspaceId)
      await pool.query("DELETE FROM app.workspaces WHERE id=$1", [workspaceId]);
    if (org)
      await pool.query("DELETE FROM app.organizations WHERE id=$1", [org]);
  } finally {
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
async function fixture(source: string | Buffer = "valid.csv", missing = false) {
  const id = randomUUID();
  const key = rawStorageKey(workspaceId, id);
  const filename = path.join(root, key);
  const bytes =
    typeof source === "string"
      ? await readFile(path.join("tests/fixtures/dataset-processing", source))
      : source;
  if (!missing) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
  }
  await pool.query(
    `INSERT INTO app.dataset_versions(id,dataset_id,version_number,source_type,storage_namespace,storage_key,original_filename,size_bytes)
    VALUES ($1,$2,$3,'CSV','raw',$4,'fixture.csv',$5)`,
    [id, dataset, ++number, key, bytes.length || null],
  );
  const scope = { workspaceId, datasetVersionId: id };
  const reference = (await loadVersion(pool, scope))!;
  return { scope, reference, filename, bytes };
}
async function state(id: string) {
  const version = (
    await pool.query("SELECT * FROM app.dataset_versions WHERE id=$1", [id])
  ).rows[0];
  const columns = (
    await pool.query(
      "SELECT * FROM app.dataset_columns WHERE dataset_version_id=$1 ORDER BY ordinal_position",
      [id],
    )
  ).rows;
  return { version, columns };
}
test("CSV válido -> schema/profile completo e READY; NULL desconhecido não vira false", async () => {
  const f = await fixture();
  const result = await processDatasetVersion(pool, f.scope);
  expect(result.outcome).toBe("TRANSITIONED");
  const { version, columns } = await state(f.scope.datasetVersionId);
  expect(version).toMatchObject({
    status: "READY",
    row_count: "2",
    column_count: 7,
    processing_error_code: null,
  });
  expect(
    columns.map((c) => [
      c.physical_name,
      c.inferred_type,
      c.ordinal_position,
      c.null_count,
      c.nullable,
      c.profile_metadata,
    ]),
  ).toEqual([
    ["id", "BIGINT", 1, "0", null, null],
    ["produto", "VARCHAR", 2, "0", null, null],
    ["quantidade", "BIGINT", 3, "0", null, null],
    ["preco_unitario", "DOUBLE", 4, "0", null, null],
    ["data", "DATE", 5, "0", null, null],
    ["ativo", "BOOLEAN", 6, "0", null, null],
    ["opcional", "VARCHAR", 7, "1", true, null],
  ]);
  for (const key of [
    "id",
    "dataset_id",
    "version_number",
    "source_type",
    "storage_namespace",
    "storage_key",
    "original_filename",
    "size_bytes",
    "created_at",
  ] as const)
    expect(version[key]).toEqual(f.reference[key]);
  expect(
    createHash("sha256")
      .update(await readFile(f.filename))
      .digest("hex"),
  ).toBe(createHash("sha256").update(f.bytes).digest("hex"));
  const before = await state(f.scope.datasetVersionId);
  expect(await processDatasetVersion(pool, f.scope)).toEqual({
    outcome: "ALREADY_TERMINAL",
    status: "READY",
  });
  expect(await state(f.scope.datasetVersionId)).toEqual(before);
});
test.each(["header-only.csv", "headers.csv"])(
  "header/nomes %s",
  async (name) => {
    const f = await fixture(name);
    expect((await processDatasetVersion(pool, f.scope)).outcome).toBe(
      "TRANSITIONED",
    );
    const { version, columns } = await state(f.scope.datasetVersionId);
    expect(version.status).toBe("READY");
    expect(columns.map((c) => c.physical_name)).toEqual(
      name === "headers.csv"
        ? ["name", "name_1", "column2", 'say"hi']
        : ["id", "name"],
    );
    expect(
      columns.every((c) => c.nullable === null && c.null_count === "0"),
    ).toBe(true);
    expect(version.row_count).toBe(name === "headers.csv" ? "1" : "0");
  },
);
test.each(["invalid.csv", Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x61])])(
  "falha determinística segura no raw %s",
  async (source) => {
    const f = await fixture(source);
    const result = await processDatasetVersion(pool, f.scope);
    expect(result.outcome).toBe("TRANSITIONED");
    const current = await state(f.scope.datasetVersionId);
    expect(current.version).toMatchObject({
      status: "FAILED",
      processing_error_code: "CSV_READ_FAILED",
      processing_error_message: "Não foi possível processar o dataset.",
    });
    expect(current.columns).toHaveLength(0);
    expect(await processDatasetVersion(pool, f.scope)).toEqual({
      outcome: "ALREADY_TERMINAL",
      status: "FAILED",
    });
  },
);
test("raw ausente em raiz disponível é determinístico; versão desconhecida/escopo errado não altera nada", async () => {
  const f = await fixture("valid.csv", true);
  await processDatasetVersion(pool, f.scope);
  expect((await state(f.scope.datasetVersionId)).version).toMatchObject({
    status: "FAILED",
    processing_error_code: "RAW_OBJECT_UNAVAILABLE",
  });
  expect(
    await processDatasetVersion(pool, {
      workspaceId,
      datasetVersionId: randomUUID(),
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await processDatasetVersion(pool, {
      workspaceId: randomUUID(),
      datasetVersionId: f.scope.datasetVersionId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
});
test("raiz temporariamente indisponível/limite operacional não finalizam FAILED", async () => {
  const f = await fixture();
  vi.stubEnv("LOCAL_STORAGE_ROOT", path.join(root, "unavailable"));
  expect((await processDatasetVersion(pool, f.scope)).outcome).toBe(
    "OPERATIONAL_FAILURE",
  );
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  vi.stubEnv("MAX_UPLOAD_BYTES", "1");
  expect((await processDatasetVersion(pool, f.scope)).outcome).toBe(
    "OPERATIONAL_FAILURE",
  );
  vi.stubEnv("MAX_UPLOAD_BYTES", "10485760");
  expect((await state(f.scope.datasetVersionId)).version.status).toBe(
    "PROCESSING",
  );
});
test("falha real de conexão PostgreSQL não altera PROCESSING", async () => {
  const f = await fixture();
  const unavailable = new Pool(getDatabaseConfig(testDatabaseUrl()));
  await unavailable.end();
  expect((await processDatasetVersion(unavailable, f.scope)).outcome).toBe(
    "OPERATIONAL_FAILURE",
  );
  expect((await state(f.scope.datasetVersionId)).version.status).toBe(
    "PROCESSING",
  );
});
function controlledPool(
  client: PoolClient,
  before: (sql: string) => Promise<void>,
  after?: (sql: string) => Promise<void>,
): Pool {
  const proxy = new Proxy(client, {
    get(target, key) {
      if (key === "query")
        return async (...args: unknown[]) => {
          await before(String(args[0]));
          const result = await Reflect.apply(target.query, target, args);
          await after?.(String(args[0]));
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { connect: async () => proxy } as unknown as Pool;
}
test("visibilidade atômica: observador só vê colunas e READY após COMMIT", async () => {
  const f = await fixture();
  const profile = await inspectCsv(f.filename, 10485760);
  const client = await pool.connect();
  let resume!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const atCommit = new Promise<void>((r) => (reached = r));
  const work = persistDatasetProfile(
    controlledPool(client, async (sql) => {
      if (sql === "COMMIT") {
        reached();
        await gate;
      }
    }),
    f.scope,
    f.reference,
    profile,
  );
  try {
    await atCommit;
    const during = await state(f.scope.datasetVersionId);
    expect(during.version.status).toBe("PROCESSING");
    expect(during.columns).toHaveLength(0);
  } finally {
    resume();
  }
  expect((await work).outcome).toBe("TRANSITIONED");
  const after = await state(f.scope.datasetVersionId);
  expect(after.version.status).toBe("READY");
  expect(after.columns).toHaveLength(7);
});
test.each(["insert", "finalize"])(
  "falha PostgreSQL real em %s reverte todas as colunas",
  async (stage) => {
    const f = await fixture();
    const profile = await inspectCsv(f.filename, 10485760);
    // Test-only trigger on disposable database, removed in finally. No migration.
    await pool.query(
      `CREATE FUNCTION app.test_processing_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test fault'; END $$`,
    );
    const table = stage === "insert" ? "dataset_columns" : "dataset_versions";
    await pool.query(
      `CREATE TRIGGER test_processing_failure BEFORE ${stage === "insert" ? "INSERT" : "UPDATE"} ON app.${table} FOR EACH ROW ${stage === "insert" ? "WHEN (NEW.ordinal_position = 2)" : "WHEN (NEW.status = 'READY')"} EXECUTE FUNCTION app.test_processing_failure()`,
    );
    try {
      await expect(
        persistDatasetProfile(pool, f.scope, f.reference, profile),
      ).rejects.toMatchObject({ outcomeUnknown: false });
      const current = await state(f.scope.datasetVersionId);
      expect(current.columns).toHaveLength(0);
      expect(current.version.status).toBe("PROCESSING");
    } finally {
      await pool.query(`DROP TRIGGER test_processing_failure ON app.${table}`);
      await pool.query("DROP FUNCTION app.test_processing_failure()");
    }
  },
);
test("resposta de COMMIT perdida preserva READY/colunas; sem compensação", async () => {
  const f = await fixture();
  const profile = await inspectCsv(f.filename, 10485760);
  const client = await pool.connect();
  await expect(
    persistDatasetProfile(
      controlledPool(
        client,
        async () => {},
        async (sql) => {
          if (sql === "COMMIT") throw new Error("lost acknowledgement");
        },
      ),
      f.scope,
      f.reference,
      profile,
    ),
  ).rejects.toMatchObject({ outcomeUnknown: true });
  const after = await state(f.scope.datasetVersionId);
  expect(after.version.status).toBe("READY");
  expect(after.columns).toHaveLength(7);
});
test("lifecycle com PoolClient é provisório: rollback desfaz READY", async () => {
  const f = await fixture();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    expect(
      (
        await markDatasetVersionReady(client, {
          ...f.scope,
          rowCount: BigInt(0),
          columnCount: 1,
        })
      ).outcome,
    ).toBe("TRANSITIONED");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect((await state(f.scope.datasetVersionId)).version.status).toBe(
    "PROCESSING",
  );
});
test.each(["READY", "FAILED"])(
  "persistência concorrente com %s: colunas e estado coerentes",
  async (other) => {
    const f = await fixture();
    const profile: DatasetProfile = await inspectCsv(f.filename, 10485760);
    const blocker = await pool.connect();
    const tag = randomUUID();
    const a = new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      application_name: `${tag}a`,
      max: 1,
    });
    const b = new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      application_name: `${tag}b`,
      max: 1,
    });
    let work: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM app.dataset_versions WHERE id=$1 FOR UPDATE",
        [f.scope.datasetVersionId],
      );
      work = Promise.allSettled([
        persistDatasetProfile(a, f.scope, f.reference, profile),
        other === "READY"
          ? persistDatasetProfile(b, f.scope, f.reference, profile)
          : markDatasetVersionFailed(b, {
              ...f.scope,
              errorCode: "CSV_READ_FAILED",
            }),
      ]);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const r = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND wait_event_type='Lock'",
          [[`${tag}a`, `${tag}b`]],
        );
        if (r.rows[0].n === 2) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      expect(blocked).toBe(true);
      await blocker.query("COMMIT");
      const outcomes = await work;
      expect(outcomes.every((r) => r.status === "fulfilled")).toBe(true);
      const results = outcomes.map((r) =>
        r.status === "fulfilled" ? (r.value as { outcome: string }) : null,
      );
      expect(results.filter((r) => r?.outcome === "TRANSITIONED")).toHaveLength(
        1,
      );
      expect(
        results.filter((r) => r?.outcome === "ALREADY_TERMINAL"),
      ).toHaveLength(1);
      const final = await state(f.scope.datasetVersionId);
      expect(final.columns).toHaveLength(
        final.version.status === "READY" ? 7 : 0,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await work;
      await a.end();
      await b.end();
    }
  },
);
