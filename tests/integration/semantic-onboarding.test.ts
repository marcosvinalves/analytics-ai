import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { initialSemanticModelName } from "../../src/modules/semantic/domain/semantic-onboarding.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { readSemanticOnboardingReadiness } from "../../src/modules/semantic/infrastructure/read-semantic-onboarding.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let otherWorkspaceId: string;
let sequence = 0;

type VersionFixture = {
  datasetId: string;
  datasetVersionId: string;
  columnId: string;
  versionNumber: number;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Semantic onboarding') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string }>(
    `INSERT INTO app.workspaces(organization_id,name)
     VALUES ($1,'Semantic onboarding'),($1,'Other workspace') RETURNING id`,
    [organizationId],
  );
  [workspaceId, otherWorkspaceId] = workspaces.rows.map((row) => row.id);
});

afterAll(async () => {
  await pool?.end();
  await resetTestDatabase();
}, 30_000);

async function createVersion(
  status: "PROCESSING" | "READY" | "FAILED" = "READY",
  datasetId?: string,
  versionNumber = 1,
): Promise<VersionFixture> {
  const number = ++sequence;
  const resolvedDatasetId =
    datasetId ??
    (
      await pool.query<{ id: string }>(
        "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,$2) RETURNING id",
        [workspaceId, `Onboarding ${number}`],
      )
    ).rows[0].id;
  const datasetVersionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key,status,
        row_count,column_count,processed_at,processing_error_code,processing_error_message)
       VALUES ($1,$2,'CSV','onboarding',$3,$4,
        CASE WHEN $4='READY' THEN 2 ELSE NULL END,
        CASE WHEN $4='READY' THEN 1 ELSE NULL END,
        CASE WHEN $4 IN ('READY','FAILED') THEN statement_timestamp() ELSE NULL END,
        CASE WHEN $4='FAILED' THEN 'CSV_PARSE_FAILED' ELSE NULL END,
        CASE WHEN $4='FAILED' THEN 'O arquivo CSV não pôde ser processado.' ELSE NULL END)
       RETURNING id`,
      [resolvedDatasetId, versionNumber, randomUUID(), status],
    )
  ).rows[0].id;
  const columnId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_columns
       (dataset_version_id,physical_name,inferred_type,ordinal_position)
       VALUES ($1,'quantity','BIGINT',1) RETURNING id`,
      [datasetVersionId],
    )
  ).rows[0].id;
  return {
    datasetId: resolvedDatasetId,
    datasetVersionId,
    columnId,
    versionNumber,
  };
}

function scope(fixture: VersionFixture) {
  return {
    workspaceId,
    datasetId: fixture.datasetId,
    datasetVersionId: fixture.datasetVersionId,
  };
}

async function createDraft(fixture: VersionFixture) {
  const result = await createSemanticModelDraft(pool, {
    ...scope(fixture),
    modelName: initialSemanticModelName(fixture.datasetId),
    label: `Dataset ${fixture.datasetId}`,
    description: null,
  });
  if (result.outcome !== "CREATED" && result.outcome !== "EXISTING")
    throw new Error("Expected semantic draft");
  return result;
}

async function completeAndPublish(
  fixture: VersionFixture,
  draft: Awaited<ReturnType<typeof createDraft>>,
) {
  const field = await createSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
    datasetColumnId: fixture.columnId,
    name: "quantity",
    label: "Quantidade",
    semanticType: { kind: "INTEGER" },
  });
  if (field.outcome !== "CREATED") throw new Error("Expected semantic field");
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
    name: "total_quantity",
    label: "Quantidade total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: field.field.fieldKey },
    },
  });
  if (metric.outcome !== "CREATED") throw new Error("Expected metric");
  const published = await publishSemanticModelRevision(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
  });
  if (published.outcome !== "PUBLISHED")
    throw new Error("Expected publication");
}

test("readiness cobre PROCESSING, FAILED, READY sem modelo e isolamento", async () => {
  const processing = await createVersion("PROCESSING");
  const failed = await createVersion("FAILED");
  const ready = await createVersion();

  expect(
    await readSemanticOnboardingReadiness(pool, scope(processing)),
  ).toMatchObject({
    outcome: "DATASET_NOT_READY",
    status: "PROCESSING",
  });
  expect(
    await readSemanticOnboardingReadiness(pool, scope(failed)),
  ).toMatchObject({
    outcome: "DATASET_NOT_READY",
    status: "FAILED",
  });
  expect(
    await readSemanticOnboardingReadiness(pool, scope(ready)),
  ).toMatchObject({
    outcome: "CAN_CREATE_DRAFT",
    dataset: { selectedVersion: { status: "READY" } },
  });
  expect(
    await readSemanticOnboardingReadiness(pool, {
      ...scope(ready),
      workspaceId: otherWorkspaceId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
});

test("readiness é read-only e expõe a versão real do draft existente", async () => {
  const first = await createVersion();
  const draft = await createDraft(first);
  const second = await createVersion("READY", first.datasetId, 2);
  const before = await pool.query(
    `SELECT m.updated_at AS model_updated_at,r.*
     FROM app.semantic_models m JOIN app.semantic_model_revisions r
       ON r.semantic_model_id=m.id WHERE m.id=$1`,
    [draft.model.id],
  );

  expect(
    await readSemanticOnboardingReadiness(pool, scope(second)),
  ).toMatchObject({
    outcome: "DRAFT_AVAILABLE",
    dataset: {
      selectedVersion: { id: second.datasetVersionId, versionNumber: 2 },
    },
    draft: { datasetVersion: { id: first.datasetVersionId, versionNumber: 1 } },
  });
  expect(
    await pool.query(
      `SELECT m.updated_at AS model_updated_at,r.*
       FROM app.semantic_models m JOIN app.semantic_model_revisions r
         ON r.semantic_model_id=m.id WHERE m.id=$1`,
      [draft.model.id],
    ),
  ).toMatchObject({ rows: before.rows });
});

test("duas criações iniciais concorrentes convergem para um único draft", async () => {
  const fixture = await createVersion();
  const input = {
    ...scope(fixture),
    modelName: initialSemanticModelName(fixture.datasetId),
    label: "Concurrent draft",
    description: null,
  };
  const results = await Promise.all([
    createSemanticModelDraft(pool, input),
    createSemanticModelDraft(pool, input),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "CREATED",
    "EXISTING",
  ]);
  expect(
    (
      await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM app.semantic_model_revisions r
         JOIN app.semantic_models m ON m.id=r.semantic_model_id
         WHERE m.dataset_id=$1 AND r.status='DRAFT'`,
        [fixture.datasetId],
      )
    ).rows[0].total,
  ).toBe(1);
});

test("modelo publicado válido e novo draft mantêm continuidade", async () => {
  const first = await createVersion();
  const publishedDraft = await createDraft(first);
  await completeAndPublish(first, publishedDraft);

  expect(
    await readSemanticOnboardingReadiness(pool, scope(first)),
  ).toMatchObject({
    outcome: "PUBLISHED_ONLY",
    published: { id: publishedDraft.revision.id },
  });

  const second = await createVersion("READY", first.datasetId, 2);
  const nextDraft = await createDraft(second);
  expect(
    await readSemanticOnboardingReadiness(pool, scope(second)),
  ).toMatchObject({
    outcome: "DRAFT_AVAILABLE",
    draft: { id: nextDraft.revision.id, datasetVersion: { versionNumber: 2 } },
    published: {
      id: publishedDraft.revision.id,
      datasetVersion: { versionNumber: 1 },
    },
  });
});

test("readiness não mistura revisions durante publicação concorrente", async () => {
  const first = await createVersion();
  const firstDraft = await createDraft(first);
  await completeAndPublish(first, firstDraft);
  const second = await createVersion("READY", first.datasetId, 2);
  const secondDraft = await createDraft(second);
  await createSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: secondDraft.revision.id,
    datasetColumnId: second.columnId,
    name: "quantity",
    label: "Quantidade",
    semanticType: { kind: "INTEGER" },
  }).then(async (field) => {
    if (field.outcome !== "CREATED") throw new Error("Expected field");
    await createMetric(pool, {
      workspaceId,
      semanticModelRevisionId: secondDraft.revision.id,
      name: "total_quantity",
      label: "Quantidade total",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: { kind: "field", fieldKey: field.field.fieldKey },
      },
    });
  });

  const realPool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  let observed!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => (observed = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  const wrappedPool = {
    connect: async () => {
      const client = await realPool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("semantic-onboarding:readiness")) {
            observed();
            await resumed;
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  try {
    const ongoing = readSemanticOnboardingReadiness(wrappedPool, scope(second));
    await paused;
    expect(
      await publishSemanticModelRevision(pool, {
        workspaceId,
        semanticModelRevisionId: secondDraft.revision.id,
      }),
    ).toMatchObject({
      outcome: "PUBLISHED",
      archivedRevisionId: firstDraft.revision.id,
    });
    resume();
    expect(await ongoing).toMatchObject({
      outcome: "DRAFT_AVAILABLE",
      draft: { id: secondDraft.revision.id },
      published: { id: firstDraft.revision.id },
    });
    expect(
      await readSemanticOnboardingReadiness(pool, scope(second)),
    ).toMatchObject({
      outcome: "PUBLISHED_ONLY",
      published: { id: secondDraft.revision.id },
    });
  } finally {
    resume();
    await realPool.end();
  }
});

test("configuração relacional inconsistente falha como BROKEN", async () => {
  const selected = await createVersion();
  const foreign = await createVersion();
  const modelId = randomUUID();
  await pool.query(
    "INSERT INTO app.semantic_models(id,dataset_id,name) VALUES($1,$2,$3)",
    [modelId, selected.datasetId, initialSemanticModelName(selected.datasetId)],
  );
  await pool.query(
    `INSERT INTO app.semantic_model_revisions
       (semantic_model_id,dataset_version_id,revision_number,label)
     VALUES ($1,$2,1,'Broken')`,
    [modelId, foreign.datasetVersionId],
  );
  expect(
    await readSemanticOnboardingReadiness(pool, scope(selected)),
  ).toMatchObject({
    outcome: "BROKEN",
  });
});
