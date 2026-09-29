import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import {
  inspectPublishedSemanticModel,
  inspectSemanticModelRevision,
} from "../../src/modules/semantic/infrastructure/semantic-inspection.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  versionId: string;
  modelId: string;
  revisionId: string;
  modelName: string;
  columns: Record<string, string>;
  fields: Record<string, { id: string; key: string }>;
  metrics: Record<string, string>;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Inspection tests') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Inspection') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await pool?.end();
  await resetTestDatabase();
}, 30_000);

async function makeReadyVersion(datasetId: string, versionNumber: number) {
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key)
       VALUES ($1,$2,'CSV','inspection',$3) RETURNING id`,
      [datasetId, versionNumber, randomUUID()],
    )
  ).rows[0].id;
  const columns: Record<string, string> = {};
  for (const [index, [name, type]] of [
    ["quantity", "BIGINT"],
    ["unit_price", "DECIMAL(18,2)"],
    ["category", "VARCHAR"],
  ].entries())
    columns[name] = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
         (dataset_version_id,physical_name,inferred_type,ordinal_position)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [versionId, name, type, index + 1],
      )
    ).rows[0].id;
  await pool.query(
    `UPDATE app.dataset_versions SET status='READY',row_count=10,column_count=3,
     processed_at=statement_timestamp() WHERE id=$1`,
    [versionId],
  );
  return { versionId, columns };
}

async function makeDraft(options?: {
  datasetId?: string;
  versionNumber?: number;
  modelName?: string;
  empty?: boolean;
}): Promise<Fixture> {
  const number = ++sequence;
  const datasetId =
    options?.datasetId ??
    (
      await pool.query<{ id: string }>(
        "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,$2) RETURNING id",
        [workspaceId, `Inspection ${number}`],
      )
    ).rows[0].id;
  const version = await makeReadyVersion(
    datasetId,
    options?.versionNumber ?? 1,
  );
  const modelName = options?.modelName ?? `inspection_${number}`;
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: version.versionId,
    modelName,
    label: `Inspection ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  const fixture: Fixture = {
    datasetId,
    versionId: version.versionId,
    modelId: draft.model.id,
    revisionId: draft.revision.id,
    modelName,
    columns: version.columns,
    fields: {},
    metrics: {},
  };
  if (options?.empty) return fixture;
  for (const [name, semanticType] of [
    ["category", { kind: "STRING" as const }],
    ["unit_price", { kind: "DECIMAL" as const, precision: 18, scale: 2 }],
    ["quantity", { kind: "INTEGER" as const }],
  ] as const) {
    const created = await createSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: fixture.revisionId,
      datasetColumnId: fixture.columns[name],
      name,
      label: name,
      semanticType,
    });
    if (created.outcome !== "CREATED") throw new Error("Expected field");
    fixture.fields[name] = {
      id: created.field.id,
      key: created.field.fieldKey,
    };
  }
  const metrics = [
    {
      name: "revenue",
      label: "Revenue",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: {
          kind: "binary",
          op: "MULTIPLY",
          left: { kind: "field", fieldKey: fixture.fields.quantity.key },
          right: { kind: "field", fieldKey: fixture.fields.unit_price.key },
        },
      },
    },
    {
      name: "category_count",
      label: "Categories",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "COUNT_DISTINCT",
        expression: {
          kind: "field",
          fieldKey: fixture.fields.category.key,
        },
      },
    },
  ];
  for (const metric of metrics) {
    const created = await createMetric(pool, {
      workspaceId,
      semanticModelRevisionId: fixture.revisionId,
      ...metric,
    });
    if (created.outcome !== "CREATED") throw new Error("Expected metric");
    fixture.metrics[metric.name] = created.metric.id;
  }
  return fixture;
}

function revisionInput(fixture: Fixture) {
  return {
    workspaceId,
    semanticModelRevisionId: fixture.revisionId,
  };
}

test("published inspection expõe contrato normalizado, derivado e ordenado", async () => {
  const fixture = await makeDraft();
  expect(
    await inspectPublishedSemanticModel(pool, {
      workspaceId,
      semanticModelId: fixture.modelId,
    }),
  ).toEqual({ outcome: "NO_PUBLISHED_REVISION" });
  expect(
    await publishSemanticModelRevision(pool, revisionInput(fixture)),
  ).toMatchObject({ outcome: "PUBLISHED" });
  const result = await inspectPublishedSemanticModel(pool, {
    workspaceId,
    semanticModelId: fixture.modelId,
  });
  expect(result.outcome).toBe("SUCCESS");
  if (result.outcome !== "SUCCESS") throw new Error("Expected inspection");
  expect(result.inspection).toMatchObject({
    model: { id: fixture.modelId, name: fixture.modelName },
    revision: { id: fixture.revisionId, status: "PUBLISHED" },
    dataset: { id: fixture.datasetId },
    datasetVersion: {
      id: fixture.versionId,
      versionNumber: 1,
      status: "READY",
    },
  });
  expect(result.inspection.fields.map((field) => field.name)).toEqual([
    "quantity",
    "unit_price",
    "category",
  ]);
  expect(result.inspection.fields[0]).not.toHaveProperty("id");
  expect(result.inspection.fields[0].lineage).toEqual({
    physicalName: "quantity",
    physicalType: "BIGINT",
    ordinalPosition: 1,
  });
  expect(result.inspection.metrics.map((metric) => metric.name)).toEqual([
    "category_count",
    "revenue",
  ]);
  expect(result.inspection.metrics[1]).toMatchObject({
    resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
    dependencies: [
      fixture.fields.quantity.key,
      fixture.fields.unit_price.key,
    ].sort(),
  });
  expect(result.inspection.metrics[1]).not.toHaveProperty("id");
});

test("specific revision aceita DRAFT, PUBLISHED e ARCHIVED", async () => {
  const first = await makeDraft();
  expect(
    await inspectSemanticModelRevision(pool, revisionInput(first)),
  ).toMatchObject({
    outcome: "SUCCESS",
    inspection: { revision: { status: "DRAFT" } },
  });
  await publishSemanticModelRevision(pool, revisionInput(first));
  expect(
    await inspectSemanticModelRevision(pool, revisionInput(first)),
  ).toMatchObject({
    outcome: "SUCCESS",
    inspection: { revision: { status: "PUBLISHED" } },
  });
  const next = await makeDraft({
    datasetId: first.datasetId,
    versionNumber: 2,
    modelName: first.modelName,
  });
  await publishSemanticModelRevision(pool, revisionInput(next));
  expect(
    await inspectSemanticModelRevision(pool, revisionInput(first)),
  ).toMatchObject({
    outcome: "SUCCESS",
    inspection: { revision: { status: "ARCHIVED" } },
  });
  expect(
    await inspectPublishedSemanticModel(pool, {
      workspaceId,
      semanticModelId: first.modelId,
    }),
  ).toMatchObject({
    outcome: "SUCCESS",
    inspection: { revision: { id: next.revisionId, status: "PUBLISHED" } },
  });
});

test("workspace incorreto e IDs inexistentes retornam NOT_FOUND", async () => {
  const fixture = await makeDraft();
  expect(
    await inspectPublishedSemanticModel(pool, {
      workspaceId: randomUUID(),
      semanticModelId: fixture.modelId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await inspectSemanticModelRevision(pool, {
      workspaceId: randomUUID(),
      semanticModelRevisionId: fixture.revisionId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
  expect(
    await inspectSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: randomUUID(),
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
});

test("DRAFT inconsistente falha sem snapshot parcial e sem repair", async () => {
  const cases: Array<{
    corrupt: (fixture: Fixture) => Promise<unknown>;
    code: string;
  }> = [
    {
      corrupt: (fixture) =>
        pool.query(
          `UPDATE app.metrics SET expression='{"version":1,"kind":"aggregate"}'::jsonb
           WHERE id=$1`,
          [fixture.metrics.revenue],
        ),
      code: "METRIC_AST_INVALID",
    },
    {
      corrupt: async (fixture) => {
        await pool.query(
          "DELETE FROM app.metric_field_references WHERE metric_id=$1",
          [fixture.metrics.revenue],
        );
        await pool.query(
          "UPDATE app.metrics SET expression=$2::jsonb WHERE id=$1",
          [
            fixture.metrics.revenue,
            JSON.stringify({
              version: 1,
              kind: "aggregate",
              op: "SUM",
              expression: { kind: "field", fieldKey: randomUUID() },
            }),
          ],
        );
      },
      code: "METRIC_FIELD_REFERENCE_INVALID",
    },
    {
      corrupt: (fixture) =>
        pool.query(
          "DELETE FROM app.metric_field_references WHERE metric_id=$1",
          [fixture.metrics.revenue],
        ),
      code: "METRIC_REFERENCE_PROJECTION_MISMATCH",
    },
    {
      corrupt: (fixture) =>
        pool.query(
          `INSERT INTO app.metric_field_references
           (metric_id,semantic_model_revision_id,field_key) VALUES ($1,$2,$3)`,
          [
            fixture.metrics.revenue,
            fixture.revisionId,
            fixture.fields.category.key,
          ],
        ),
      code: "METRIC_REFERENCE_PROJECTION_MISMATCH",
    },
    {
      corrupt: async (fixture) => {
        await pool.query(
          "DELETE FROM app.metric_field_references WHERE metric_id=$1",
          [fixture.metrics.revenue],
        );
        await pool.query(
          "UPDATE app.metrics SET expression=$2::jsonb WHERE id=$1",
          [
            fixture.metrics.revenue,
            JSON.stringify({
              version: 1,
              kind: "aggregate",
              op: "SUM",
              expression: {
                kind: "field",
                fieldKey: fixture.fields.category.key,
              },
            }),
          ],
        );
        await pool.query(
          `INSERT INTO app.metric_field_references
           (metric_id,semantic_model_revision_id,field_key) VALUES ($1,$2,$3)`,
          [
            fixture.metrics.revenue,
            fixture.revisionId,
            fixture.fields.category.key,
          ],
        );
      },
      code: "METRIC_TYPE_INVALID",
    },
  ];
  for (const item of cases) {
    const fixture = await makeDraft();
    await item.corrupt(fixture);
    const result = await inspectSemanticModelRevision(
      pool,
      revisionInput(fixture),
    );
    expect(result).toMatchObject({
      outcome: "INCONSISTENT_SNAPSHOT",
      semanticModelRevisionId: fixture.revisionId,
      status: "DRAFT",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: item.code }),
      ]),
    });
    expect(result).not.toHaveProperty("inspection");
  }
});

test("PUBLISHED e ARCHIVED corrompidos por SQL administrativo falham de forma segura", async () => {
  const fixture = await makeDraft();
  await pool.query(
    "DELETE FROM app.metric_field_references WHERE metric_id=$1",
    [fixture.metrics.revenue],
  );
  await pool.query(
    `UPDATE app.semantic_model_revisions
     SET status='PUBLISHED',published_at=statement_timestamp() WHERE id=$1`,
    [fixture.revisionId],
  );
  expect(
    await inspectPublishedSemanticModel(pool, {
      workspaceId,
      semanticModelId: fixture.modelId,
    }),
  ).toMatchObject({
    outcome: "INCONSISTENT_SNAPSHOT",
    status: "PUBLISHED",
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: "METRIC_REFERENCE_PROJECTION_MISMATCH",
      }),
    ]),
  });
  await pool.query(
    "UPDATE app.semantic_model_revisions SET status='ARCHIVED' WHERE id=$1",
    [fixture.revisionId],
  );
  expect(
    await inspectSemanticModelRevision(pool, revisionInput(fixture)),
  ).toMatchObject({
    outcome: "INCONSISTENT_SNAPSHOT",
    status: "ARCHIVED",
  });
});

async function metadataState(fixture: Fixture): Promise<unknown> {
  return (
    await pool.query<{ state: unknown }>(
      `SELECT jsonb_build_object(
        'dataset', (SELECT to_jsonb(d) FROM app.datasets d WHERE d.id=$1),
        'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM app.dataset_versions v WHERE v.dataset_id=$1),
        'columns', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.dataset_columns c JOIN app.dataset_versions v ON v.id=c.dataset_version_id WHERE v.dataset_id=$1),
        'model', (SELECT to_jsonb(m) FROM app.semantic_models m WHERE m.id=$2),
        'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM app.semantic_model_revisions r WHERE r.semantic_model_id=$2),
        'fields', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM app.semantic_fields f JOIN app.semantic_model_revisions r ON r.id=f.semantic_model_revision_id WHERE r.semantic_model_id=$2),
        'metrics', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM app.metrics m JOIN app.semantic_model_revisions r ON r.id=m.semantic_model_revision_id WHERE r.semantic_model_id=$2),
        'references', (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.metric_id,x.field_key) FROM app.metric_field_references x JOIN app.metrics m ON m.id=x.metric_id JOIN app.semantic_model_revisions r ON r.id=m.semantic_model_revision_id WHERE r.semantic_model_id=$2)
      ) AS state`,
      [fixture.datasetId, fixture.modelId],
    )
  ).rows[0].state;
}

test("inspection é integralmente read-only para metadata e timestamps", async () => {
  const fixture = await makeDraft();
  await publishSemanticModelRevision(pool, revisionInput(fixture));
  const before = await metadataState(fixture);
  expect(
    await inspectSemanticModelRevision(pool, revisionInput(fixture)),
  ).toMatchObject({
    outcome: "SUCCESS",
  });
  expect(
    await inspectPublishedSemanticModel(pool, {
      workspaceId,
      semanticModelId: fixture.modelId,
    }),
  ).toMatchObject({ outcome: "SUCCESS" });
  expect(await metadataState(fixture)).toEqual(before);
});

test("published resolution e conteúdo permanecem no mesmo snapshot MVCC", async () => {
  const first = await makeDraft();
  await publishSemanticModelRevision(pool, revisionInput(first));
  const next = await makeDraft({
    datasetId: first.datasetId,
    versionNumber: 2,
    modelName: first.modelName,
  });
  const realPool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  let releaseResolution!: () => void;
  let resolutionObserved!: () => void;
  const paused = new Promise<void>((resolve) => {
    resolutionObserved = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  const statements: string[] = [];
  const wrappedPool = {
    connect: async () => {
      const client = await realPool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql.includes("semantic-inspection:published")) {
            resolutionObserved();
            await resume;
          }
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  try {
    const ongoing = inspectPublishedSemanticModel(wrappedPool, {
      workspaceId,
      semanticModelId: first.modelId,
    });
    await paused;
    expect(
      await publishSemanticModelRevision(pool, revisionInput(next)),
    ).toMatchObject({
      outcome: "PUBLISHED",
      archivedRevisionId: first.revisionId,
    });
    releaseResolution();
    expect(await ongoing).toMatchObject({
      outcome: "SUCCESS",
      inspection: {
        revision: { id: first.revisionId, status: "PUBLISHED" },
        datasetVersion: { id: first.versionId },
      },
    });
    expect(statements.filter((sql) => /\bSELECT\b/i.test(sql))).toHaveLength(4);
    expect(
      await inspectPublishedSemanticModel(pool, {
        workspaceId,
        semanticModelId: first.modelId,
      }),
    ).toMatchObject({
      outcome: "SUCCESS",
      inspection: {
        revision: { id: next.revisionId, status: "PUBLISHED" },
        datasetVersion: { id: next.versionId },
      },
    });
  } finally {
    releaseResolution();
    await realPool.end();
  }
});

test("erro durante leitura executa ROLLBACK e retorna falha operacional", async () => {
  const fixture = await makeDraft();
  const realPool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const statements: string[] = [];
  const wrappedPool = {
    connect: async () => {
      const client = await realPool.connect();
      return {
        query: async (
          sql: string,
          values?: unknown[],
        ): Promise<QueryResult> => {
          statements.push(sql);
          if (sql.includes("FROM app.semantic_fields"))
            throw new Error("forced read failure");
          return client.query(sql, values);
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  try {
    expect(
      await inspectSemanticModelRevision(wrappedPool, revisionInput(fixture)),
    ).toEqual({ outcome: "OPERATIONAL_FAILURE" });
    expect(statements).toContain("ROLLBACK");
  } finally {
    await realPool.end();
  }
});
