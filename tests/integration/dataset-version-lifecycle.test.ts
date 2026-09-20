import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { beforeAll, afterAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { testDatabaseUrl } from "./helpers/database.ts";
import {
  markDatasetVersionReady as ready,
  markDatasetVersionFailed as failed,
} from "../../src/modules/dataset/infrastructure/dataset-version-lifecycle.ts";
import {
  SAFE_PROCESSING_MESSAGE,
  type TransitionResult,
} from "../../src/modules/dataset/domain/dataset-version-lifecycle.ts";

let pool: Pool;
let organizationId: string;
let workspaceId: string;
let datasetId: string;
let number = 0;
beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Lifecycle test') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id, name) VALUES ($1, 'Lifecycle') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
  datasetId = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id, name) VALUES ($1, 'Lifecycle') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id;
});
afterAll(async () => {
  if (!pool) return;
  try {
    if (datasetId) {
      await pool.query(
        "DELETE FROM app.dataset_versions WHERE dataset_id = $1",
        [datasetId],
      );
      await pool.query("DELETE FROM app.datasets WHERE id = $1", [datasetId]);
    }
    if (workspaceId)
      await pool.query("DELETE FROM app.workspaces WHERE id = $1", [
        workspaceId,
      ]);
    if (organizationId)
      await pool.query("DELETE FROM app.organizations WHERE id = $1", [
        organizationId,
      ]);
  } finally {
    await pool.end();
  }
});
async function fixture() {
  const row = (
    await pool.query(
      `INSERT INTO app.dataset_versions
    (dataset_id, version_number, source_type, storage_namespace, storage_key, original_filename, size_bytes)
    VALUES ($1, $2, 'CSV', 'raw', $3, 'fixture.csv', 20) RETURNING *`,
      [datasetId, ++number, randomUUID()],
    )
  ).rows[0];
  return {
    before: row,
    scope: { workspaceId, datasetVersionId: row.id as string },
  };
}
async function read(id: string) {
  return (
    await pool.query("SELECT * FROM app.dataset_versions WHERE id = $1", [id])
  ).rows[0];
}
const identity = [
  "id",
  "dataset_id",
  "version_number",
  "source_type",
  "storage_namespace",
  "storage_key",
  "original_filename",
  "size_bytes",
  "created_at",
];

test.each(["READY", "FAILED"] as const)(
  "PROCESSING -> %s respeita contrato e identidade",
  async (status) => {
    const { before, scope } = await fixture();
    const result =
      status === "READY"
        ? await ready(pool, {
            ...scope,
            rowCount: BigInt("9223372036854775807"),
            columnCount: 1,
          })
        : await failed(pool, {
            ...scope,
            errorCode: "CSV_PARSE_FAILED",
            errorMessage: SAFE_PROCESSING_MESSAGE,
          });
    expect(result.outcome).toBe("TRANSITIONED");
    const after = await read(before.id);
    for (const key of identity) expect(after[key]).toEqual(before[key]);
    expect(after.status).toBe(status);
    expect(after.processed_at).toBeInstanceOf(Date);
    expect(after.processed_at.getTime()).toBeGreaterThanOrEqual(
      after.created_at.getTime(),
    );
    expect(after.updated_at).toEqual(after.processed_at);
    if (status === "READY") {
      expect(after.row_count).toBe("9223372036854775807");
      expect(after.column_count).toBe(1);
      expect(after.processing_error_code).toBeNull();
      expect(after.processing_error_message).toBeNull();
      if (result.outcome === "TRANSITIONED")
        expect(result.version.rowCount).toBe(BigInt("9223372036854775807"));
    } else {
      expect(after.processing_error_code).toBe("CSV_PARSE_FAILED");
      expect(after.processing_error_message).toBe(SAFE_PROCESSING_MESSAGE);
      expect(after.row_count).toBeNull();
      expect(after.column_count).toBeNull();
    }
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.dataset_columns WHERE dataset_version_id = $1",
          [before.id],
        )
      ).rowCount,
    ).toBe(0);
  },
);
test("READY permite zero linhas e FAILED preserva contagens parciais e mensagem NULL", async () => {
  const a = await fixture();
  await ready(pool, { ...a.scope, rowCount: BigInt(0), columnCount: 1 });
  expect((await read(a.before.id)).row_count).toBe("0");
  const b = await fixture();
  await pool.query(
    "UPDATE app.dataset_versions SET row_count = 3, column_count = 2 WHERE id = $1",
    [b.before.id],
  );
  await failed(pool, { ...b.scope, errorCode: "SCHEMA_INFERENCE_FAILED" });
  expect(await read(b.before.id)).toMatchObject({
    row_count: "3",
    column_count: 2,
    processing_error_message: null,
  });
});
test.each(["READY", "FAILED"] as const)(
  "%s é terminal, inclusive repetição e timestamps",
  async (status) => {
    const { scope } = await fixture();
    if (status === "READY")
      await ready(pool, { ...scope, rowCount: BigInt(0), columnCount: 1 });
    else await failed(pool, { ...scope, errorCode: "FAILED" });
    const before = await read(scope.datasetVersionId);
    expect(
      await ready(pool, { ...scope, rowCount: BigInt(99), columnCount: 3 }),
    ).toEqual({ outcome: "ALREADY_TERMINAL", status });
    expect(
      await failed(pool, { ...scope, errorCode: "OTHER_FAILURE" }),
    ).toEqual({ outcome: "ALREADY_TERMINAL", status });
    expect(await read(scope.datasetVersionId)).toEqual(before);
  },
);
test("inexistência e workspace diferente retornam NOT_FOUND sem alterar versão", async () => {
  const { scope, before } = await fixture();
  for (const target of [
    { ...scope, datasetVersionId: randomUUID() },
    { ...scope, workspaceId: randomUUID() },
  ]) {
    expect(
      await ready(pool, { ...target, rowCount: BigInt(0), columnCount: 1 }),
    ).toEqual({ outcome: "NOT_FOUND" });
    expect(await failed(pool, { ...target, errorCode: "FAILED" })).toEqual({
      outcome: "NOT_FOUND",
    });
  }
  expect(await read(scope.datasetVersionId)).toEqual(before);
});
test("argumentos inválidos não alteram PROCESSING", async () => {
  const { scope, before } = await fixture();
  await expect(
    ready(pool, { ...scope, rowCount: BigInt(0), columnCount: 0 }),
  ).rejects.toThrow(TypeError);
  await expect(
    failed(pool, { ...scope, errorCode: "not safe" }),
  ).rejects.toThrow(TypeError);
  expect(await read(scope.datasetVersionId)).toEqual(before);
});

test.each(["READY", "FAILED"] as const)(
  "READY concorrendo com %s: exatamente um vencedor",
  async (secondStatus) => {
    const { scope, before } = await fixture();
    const blocker = await pool.connect();
    const tag = `lifecycle-race-${randomUUID()}`;
    const writers = [
      new Pool({
        ...getDatabaseConfig(testDatabaseUrl()),
        max: 1,
        application_name: `${tag}-a`,
      }),
      new Pool({
        ...getDatabaseConfig(testDatabaseUrl()),
        max: 1,
        application_name: `${tag}-b`,
      }),
    ];
    let attempts: Promise<PromiseSettledResult<TransitionResult>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM app.dataset_versions WHERE id = $1 FOR UPDATE",
        [before.id],
      );
      attempts = Promise.allSettled([
        ready(writers[0], { ...scope, rowCount: BigInt(10), columnCount: 2 }),
        secondStatus === "READY"
          ? ready(writers[1], {
              ...scope,
              rowCount: BigInt(20),
              columnCount: 3,
            })
          : failed(writers[1], {
              ...scope,
              errorCode: "CSV_PARSE_FAILED",
              errorMessage: SAFE_PROCESSING_MESSAGE,
            }),
      ]);
      // Observe actual blocked backends before releasing, not merely concurrent JS promises.
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'",
          [[`${tag}-a`, `${tag}-b`]],
        );
        if (result.rows[0].n === 2) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      expect(
        blocked,
        "Both independent PostgreSQL sessions must be blocked",
      ).toBe(true);
      await blocker.query("COMMIT");
      const settled = await attempts;
      const results = settled.map((item) => {
        if (item.status === "rejected") throw item.reason;
        return item.value;
      });
      expect(results.filter((r) => r.outcome === "TRANSITIONED")).toHaveLength(
        1,
      );
      expect(
        results.filter((r) => r.outcome === "ALREADY_TERMINAL"),
      ).toHaveLength(1);
      const winnerIndex = results.findIndex(
        (r) => r.outcome === "TRANSITIONED",
      );
      const after = await read(before.id);
      for (const key of identity) expect(after[key]).toEqual(before[key]);
      if (winnerIndex === 0 || secondStatus === "READY") {
        expect(after).toMatchObject({
          status: "READY",
          row_count: winnerIndex === 0 ? "10" : "20",
          column_count: winnerIndex === 0 ? 2 : 3,
          processing_error_code: null,
          processing_error_message: null,
        });
      } else
        expect(after).toMatchObject({
          status: "FAILED",
          row_count: null,
          column_count: null,
          processing_error_code: "CSV_PARSE_FAILED",
          processing_error_message: SAFE_PROCESSING_MESSAGE,
        });
      expect(results[1 - winnerIndex]).toEqual({
        outcome: "ALREADY_TERMINAL",
        status: after.status,
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await attempts;
      await Promise.all(writers.map((writer) => writer.end()));
    }
  },
);
