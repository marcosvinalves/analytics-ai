import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import {
  publishSemanticModelRevision,
  validateSemanticModelRevision,
} from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  versionId: string;
  modelId: string;
  revisionId: string;
  columns: Record<string, string>;
  fields: Record<string, { id: string; key: string }>;
  metricId: string;
};

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Publication tests') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Publication') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await pool?.end();
  await resetTestDatabase();
}, 30_000);

async function makeReadyVersion(
  datasetId: string,
  versionNumber: number,
): Promise<{ versionId: string; columns: Record<string, string> }> {
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key)
       VALUES ($1,$2,'CSV','publication',$3) RETURNING id`,
      [datasetId, versionNumber, randomUUID()],
    )
  ).rows[0].id;
  const columns: Record<string, string> = {};
  for (const [index, [name, type]] of [
    ["quantity", "BIGINT"],
    ["category", "VARCHAR"],
    ["unused", "VARCHAR"],
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
    `UPDATE app.dataset_versions SET status='READY',row_count=3,column_count=3,
     processed_at=statement_timestamp() WHERE id=$1`,
    [versionId],
  );
  return { versionId, columns };
}

async function makeDraft(options?: {
  empty?: boolean;
  datasetId?: string;
  versionNumber?: number;
  modelName?: string;
}): Promise<Fixture> {
  const number = ++sequence;
  const datasetId =
    options?.datasetId ??
    (
      await pool.query<{ id: string }>(
        "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,$2) RETURNING id",
        [workspaceId, `Publication ${number}`],
      )
    ).rows[0].id;
  const version = await makeReadyVersion(
    datasetId,
    options?.versionNumber ?? 1,
  );
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: version.versionId,
    modelName: options?.modelName ?? `publication_${number}`,
    label: `Publication ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  const fixture: Fixture = {
    datasetId,
    versionId: version.versionId,
    modelId: draft.model.id,
    revisionId: draft.revision.id,
    columns: version.columns,
    fields: {},
    metricId: "",
  };
  if (options?.empty) return fixture;
  for (const [name, semanticType] of [
    ["quantity", { kind: "INTEGER" as const }],
    ["category", { kind: "STRING" as const }],
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
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: fixture.revisionId,
    name: "total_quantity",
    label: "Quantidade total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: fixture.fields.quantity.key },
    },
  });
  if (metric.outcome !== "CREATED") throw new Error("Expected metric");
  fixture.metricId = metric.metric.id;
  return fixture;
}

function scope(fixture: Fixture) {
  return {
    workspaceId,
    semanticModelRevisionId: fixture.revisionId,
  };
}

test("migration instala os guards específicos de lifecycle e conteúdo", async () => {
  const triggers = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
     ('semantic_model_revisions_lifecycle_guard','semantic_fields_content_draft_guard',
      'metrics_content_draft_guard','metric_field_references_content_draft_guard')
     ORDER BY tgname`,
  );
  expect(triggers.rows.map((row) => row.tgname)).toEqual([
    "metric_field_references_content_draft_guard",
    "metrics_content_draft_guard",
    "semantic_fields_content_draft_guard",
    "semantic_model_revisions_lifecycle_guard",
  ]);
});

test("validation é read-only, determinística e separa elegibilidade", async () => {
  const valid = await makeDraft();
  const before = await pool.query(
    "SELECT status,published_at,updated_at FROM app.semantic_model_revisions WHERE id=$1",
    [valid.revisionId],
  );
  expect(await validateSemanticModelRevision(pool, scope(valid))).toEqual({
    outcome: "VALID",
    fieldCount: 2,
    metricCount: 1,
  });
  expect(
    (
      await pool.query(
        "SELECT status,published_at,updated_at FROM app.semantic_model_revisions WHERE id=$1",
        [valid.revisionId],
      )
    ).rows,
  ).toEqual(before.rows);
  await pool.query(
    "UPDATE app.semantic_model_revisions SET status='PUBLISHED',published_at=statement_timestamp() WHERE id=$1",
    [valid.revisionId],
  );
  expect(await validateSemanticModelRevision(pool, scope(valid))).toEqual({
    outcome: "REVISION_NOT_DRAFT",
    status: "PUBLISHED",
  });
  expect(
    await validateSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: randomUUID(),
    }),
  ).toEqual({ outcome: "NOT_FOUND" });
});

test("validation relata vazio, versão não READY e corrupções administrativas", async () => {
  const empty = await makeDraft({ empty: true });
  expect(
    (await validateSemanticModelRevision(pool, scope(empty))).outcome,
  ).toBe("INVALID");
  const emptyResult = await validateSemanticModelRevision(pool, scope(empty));
  if (emptyResult.outcome !== "INVALID") throw new Error("Expected invalid");
  expect(emptyResult.issues.map((item) => item.code)).toEqual([
    "NO_FIELDS",
    "NO_METRICS",
  ]);

  const notReady = await makeDraft();
  await pool.query(
    `UPDATE app.dataset_versions SET status='PROCESSING',row_count=NULL,column_count=NULL,
     processed_at=NULL WHERE id=$1`,
    [notReady.versionId],
  );
  const notReadyResult = await validateSemanticModelRevision(
    pool,
    scope(notReady),
  );
  expect(notReadyResult).toMatchObject({ outcome: "INVALID" });
  if (notReadyResult.outcome === "INVALID")
    expect(notReadyResult.issues.map((item) => item.code)).toContain(
      "DATASET_VERSION_NOT_READY",
    );

  const incompatible = await makeDraft();
  await pool.query(
    `UPDATE app.semantic_fields SET semantic_type='DATE'
     WHERE id=$1`,
    [incompatible.fields.quantity.id],
  );
  const incompatibleResult = await validateSemanticModelRevision(
    pool,
    scope(incompatible),
  );
  if (incompatibleResult.outcome !== "INVALID")
    throw new Error("Expected invalid");
  expect(incompatibleResult.issues.map((item) => item.code)).toContain(
    "FIELD_PHYSICAL_COMPATIBILITY_INVALID",
  );

  const corruptMetric = await makeDraft();
  await pool.query(
    `UPDATE app.metrics SET expression='{"version":1,"kind":"aggregate"}'::jsonb
     WHERE id=$1`,
    [corruptMetric.metricId],
  );
  const astResult = await validateSemanticModelRevision(
    pool,
    scope(corruptMetric),
  );
  if (astResult.outcome !== "INVALID") throw new Error("Expected invalid");
  expect(astResult.issues.map((item) => item.code)).toContain(
    "METRIC_AST_INVALID",
  );

  const projection = await makeDraft();
  await pool.query(
    "DELETE FROM app.metric_field_references WHERE metric_id=$1",
    [projection.metricId],
  );
  const projectionResult = await validateSemanticModelRevision(
    pool,
    scope(projection),
  );
  if (projectionResult.outcome !== "INVALID")
    throw new Error("Expected invalid");
  expect(projectionResult.issues.map((item) => item.code)).toContain(
    "METRIC_REFERENCE_PROJECTION_MISMATCH",
  );

  const unknownField = await makeDraft();
  await pool.query(
    "DELETE FROM app.metric_field_references WHERE metric_id=$1",
    [unknownField.metricId],
  );
  await pool.query("UPDATE app.metrics SET expression=$2::jsonb WHERE id=$1", [
    unknownField.metricId,
    JSON.stringify({
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: randomUUID() },
    }),
  ]);
  const unknownResult = await validateSemanticModelRevision(
    pool,
    scope(unknownField),
  );
  if (unknownResult.outcome !== "INVALID") throw new Error("Expected invalid");
  expect(unknownResult.issues.map((item) => item.code)).toContain(
    "METRIC_FIELD_REFERENCE_INVALID",
  );

  const typeFailure = await makeDraft();
  await pool.query(`UPDATE app.metrics SET expression=$2::jsonb WHERE id=$1`, [
    typeFailure.metricId,
    JSON.stringify({
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "field",
        fieldKey: typeFailure.fields.category.key,
      },
    }),
  ]);
  await pool.query(
    `UPDATE app.metric_field_references SET field_key=$2 WHERE metric_id=$1`,
    [typeFailure.metricId, typeFailure.fields.category.key],
  );
  const typeResult = await validateSemanticModelRevision(
    pool,
    scope(typeFailure),
  );
  if (typeResult.outcome !== "INVALID") throw new Error("Expected invalid");
  expect(typeResult.issues.map((item) => item.code)).toContain(
    "METRIC_TYPE_INVALID",
  );
});

test("publication preenche published_at, é idempotente e substitui atomicamente", async () => {
  const first = await makeDraft();
  const published = await publishSemanticModelRevision(pool, scope(first));
  expect(published).toMatchObject({
    outcome: "PUBLISHED",
    archivedRevisionId: null,
    revision: { status: "PUBLISHED" },
  });
  if (published.outcome !== "PUBLISHED") throw new Error("Expected published");
  expect(published.revision.publishedAt).toBeInstanceOf(Date);
  expect(await publishSemanticModelRevision(pool, scope(first))).toMatchObject({
    outcome: "ALREADY_PUBLISHED",
    revision: { id: first.revisionId },
  });

  const next = await makeDraft({
    datasetId: first.datasetId,
    versionNumber: 2,
    modelName: `publication_${sequence}`,
  });
  expect(next.modelId).toBe(first.modelId);
  const replacement = await publishSemanticModelRevision(pool, scope(next));
  expect(replacement).toMatchObject({
    outcome: "PUBLISHED",
    archivedRevisionId: first.revisionId,
  });
  const rows = await pool.query<{
    id: string;
    status: string;
    published_at: Date;
  }>(
    `SELECT id,status,published_at FROM app.semantic_model_revisions
     WHERE semantic_model_id=$1 ORDER BY revision_number`,
    [first.modelId],
  );
  expect(rows.rows.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: first.revisionId, status: "ARCHIVED" },
    { id: next.revisionId, status: "PUBLISHED" },
  ]);
  expect(rows.rows[0].published_at).toEqual(published.revision.publishedAt);
});

test("validation failure confirma rollback da publicação", async () => {
  const fixture = await makeDraft({ empty: true });
  expect(
    await publishSemanticModelRevision(pool, scope(fixture)),
  ).toMatchObject({ outcome: "VALIDATION_FAILED" });
  expect(
    (
      await pool.query(
        "SELECT status,published_at FROM app.semantic_model_revisions WHERE id=$1",
        [fixture.revisionId],
      )
    ).rows[0],
  ).toEqual({ status: "DRAFT", published_at: null });
});

test("guard rejeita criação e transições fora do lifecycle", async () => {
  const draft = await makeDraft();
  await expect(
    pool.query(
      `UPDATE app.semantic_model_revisions
       SET status='ARCHIVED',published_at=statement_timestamp() WHERE id=$1`,
      [draft.revisionId],
    ),
  ).rejects.toMatchObject({
    code: "55000",
    constraint: "semantic_revision_lifecycle_guard",
  });
  await expect(
    pool.query(
      `INSERT INTO app.semantic_model_revisions
       (semantic_model_id,dataset_version_id,revision_number,status,label,published_at)
       VALUES ($1,$2,99,'PUBLISHED','Invalid',statement_timestamp())`,
      [draft.modelId, draft.versionId],
    ),
  ).rejects.toMatchObject({
    code: "55000",
    constraint: "semantic_revision_lifecycle_guard",
  });
  expect(await publishSemanticModelRevision(pool, scope(draft))).toMatchObject({
    outcome: "PUBLISHED",
  });
  await expect(
    pool.query(
      `UPDATE app.semantic_model_revisions
       SET status='DRAFT',published_at=NULL WHERE id=$1`,
      [draft.revisionId],
    ),
  ).rejects.toMatchObject({
    code: "55000",
    constraint: "semantic_revision_lifecycle_guard",
  });
});

async function exerciseContentDml(client: PoolClient, fixture: Fixture) {
  await client.query(
    "UPDATE app.semantic_fields SET label=label || ' ok' WHERE id=$1",
    [fixture.fields.quantity.id],
  );
  await client.query(
    "UPDATE app.metrics SET label=label || ' ok' WHERE id=$1",
    [fixture.metricId],
  );
  const fieldId = (
    await client.query<{ id: string }>(
      `INSERT INTO app.semantic_fields
       (semantic_model_revision_id,dataset_version_id,dataset_column_id,name,label,semantic_type)
       VALUES ($1,$2,$3,'temporary','Temporary','STRING') RETURNING id`,
      [fixture.revisionId, fixture.versionId, fixture.columns.unused],
    )
  ).rows[0].id;
  await client.query(
    "UPDATE app.semantic_fields SET label='Changed' WHERE id=$1",
    [fieldId],
  );
  await client.query("DELETE FROM app.semantic_fields WHERE id=$1", [fieldId]);
  const metricId = (
    await client.query<{ id: string }>(
      `INSERT INTO app.metrics (semantic_model_revision_id,name,label,expression)
       VALUES ($1,'temporary','Temporary',$2::jsonb) RETURNING id`,
      [
        fixture.revisionId,
        JSON.stringify({
          version: 1,
          kind: "aggregate",
          op: "COUNT",
          expression: { kind: "literal", type: "INTEGER", value: "1" },
        }),
      ],
    )
  ).rows[0].id;
  await client.query("UPDATE app.metrics SET label='Changed' WHERE id=$1", [
    metricId,
  ]);
  await client.query("DELETE FROM app.metrics WHERE id=$1", [metricId]);
}

test("FOR UPDATE da revision seguido pelos triggers FOR SHARE conclui em COMMIT e ROLLBACK", async () => {
  const committed = await makeDraft();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id=$1 FOR UPDATE",
      [committed.revisionId],
    );
    await exerciseContentDml(client, committed);
    await client.query("COMMIT");

    const rolledBack = await makeDraft();
    const before = (
      await client.query<{ label: string }>(
        "SELECT label FROM app.semantic_fields WHERE id=$1",
        [rolledBack.fields.quantity.id],
      )
    ).rows[0].label;
    await client.query("BEGIN");
    await client.query(
      "SELECT id FROM app.semantic_model_revisions WHERE id=$1 FOR UPDATE",
      [rolledBack.revisionId],
    );
    await exerciseContentDml(client, rolledBack);
    await client.query("ROLLBACK");
    expect(
      (
        await client.query<{ label: string }>(
          "SELECT label FROM app.semantic_fields WHERE id=$1",
          [rolledBack.fields.quantity.id],
        )
      ).rows[0].label,
    ).toBe(before);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("SQL direto não altera conteúdo nem metadata de PUBLISHED ou ARCHIVED", async () => {
  const fixture = await makeDraft();
  const published = await publishSemanticModelRevision(pool, scope(fixture));
  if (published.outcome !== "PUBLISHED") throw new Error("Expected published");
  const expectGuard = async (query: Promise<unknown>, constraint: string) =>
    expect(query).rejects.toMatchObject({ code: "55000", constraint });
  await expectGuard(
    pool.query(
      `INSERT INTO app.semantic_fields
       (semantic_model_revision_id,dataset_version_id,dataset_column_id,name,label,semantic_type)
       VALUES ($1,$2,$3,'blocked','Blocked','STRING')`,
      [fixture.revisionId, fixture.versionId, fixture.columns.unused],
    ),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("UPDATE app.semantic_fields SET label='x' WHERE id=$1", [
      fixture.fields.quantity.id,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.semantic_fields WHERE id=$1", [
      fixture.fields.category.id,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query(
      `INSERT INTO app.metrics (semantic_model_revision_id,name,label,expression)
       VALUES ($1,'blocked','Blocked',$2::jsonb)`,
      [
        fixture.revisionId,
        JSON.stringify({
          version: 1,
          kind: "aggregate",
          op: "COUNT",
          expression: { kind: "literal", type: "INTEGER", value: "1" },
        }),
      ],
    ),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("UPDATE app.metrics SET label='x' WHERE id=$1", [
      fixture.metricId,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.metrics WHERE id=$1", [fixture.metricId]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query(
      `INSERT INTO app.metric_field_references
       (metric_id,semantic_model_revision_id,field_key) VALUES ($1,$2,$3)`,
      [fixture.metricId, fixture.revisionId, fixture.fields.category.key],
    ),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query(
      "UPDATE app.metric_field_references SET field_key=$2 WHERE metric_id=$1",
      [fixture.metricId, fixture.fields.category.key],
    ),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.metric_field_references WHERE metric_id=$1", [
      fixture.metricId,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query(
      "UPDATE app.semantic_model_revisions SET label='x' WHERE id=$1",
      [fixture.revisionId],
    ),
    "semantic_revision_lifecycle_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.semantic_model_revisions WHERE id=$1", [
      fixture.revisionId,
    ]),
    "semantic_revision_lifecycle_guard",
  );
  for (const assignment of [
    `id = gen_random_uuid()`,
    `semantic_model_id = gen_random_uuid()`,
    `dataset_version_id = gen_random_uuid()`,
    `revision_number = revision_number + 1`,
    `label = 'changed'`,
    `description = 'changed'`,
    `published_at = published_at + interval '1 second'`,
    `created_at = created_at - interval '1 second'`,
  ])
    await expectGuard(
      pool.query(
        `UPDATE app.semantic_model_revisions SET status='ARCHIVED', ${assignment} WHERE id=$1`,
        [fixture.revisionId],
      ),
      "semantic_revision_lifecycle_guard",
    );
  await pool.query(
    "UPDATE app.semantic_model_revisions SET status='ARCHIVED' WHERE id=$1",
    [fixture.revisionId],
  );
  await expectGuard(
    pool.query("UPDATE app.metrics SET label='x' WHERE id=$1", [
      fixture.metricId,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.semantic_fields WHERE id=$1", [
      fixture.fields.quantity.id,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query("DELETE FROM app.metric_field_references WHERE metric_id=$1", [
      fixture.metricId,
    ]),
    "semantic_revision_content_draft_guard",
  );
  await expectGuard(
    pool.query(
      "UPDATE app.semantic_model_revisions SET status='PUBLISHED' WHERE id=$1",
      [fixture.revisionId],
    ),
    "semantic_revision_lifecycle_guard",
  );
  expect(
    (
      await pool.query<{ published_at: Date }>(
        "SELECT published_at FROM app.semantic_model_revisions WHERE id=$1",
        [fixture.revisionId],
      )
    ).rows[0].published_at,
  ).toEqual(published.revision.publishedAt);
});

async function expectBlocked(tag: string, count: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE application_name LIKE $1 AND wait_event_type='Lock'`,
      [`${tag}%`],
    );
    if (result.rows[0].count === count) return;
    await delay(10);
  }
  throw new Error(`Expected ${count} blocked sessions`);
}

test("publish serializa com mutação direta de field e metric", async () => {
  for (const table of ["semantic_fields", "metrics"] as const) {
    const fixture = await makeDraft();
    const tag = `pubw-${++sequence}`;
    const writer = new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-writer`,
    });
    const publisher = new Pool({
      ...getDatabaseConfig(testDatabaseUrl()),
      max: 1,
      application_name: `${tag}-publisher`,
    });
    const client = await writer.connect();
    let publication:
      ReturnType<typeof publishSemanticModelRevision> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE app.${table} SET label=label || ' serialized' WHERE id=$1`,
        [
          table === "semantic_fields"
            ? fixture.fields.quantity.id
            : fixture.metricId,
        ],
      );
      publication = publishSemanticModelRevision(publisher, scope(fixture));
      await expectBlocked(tag, 1);
      await client.query("COMMIT");
      expect(await publication).toMatchObject({ outcome: "PUBLISHED" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await publication;
      await writer.end();
      await publisher.end();
    }
  }
});

test("duas publications do mesmo SemanticModel deixam exatamente uma PUBLISHED", async () => {
  const fixture = await makeDraft();
  const tag = `pubr-${++sequence}`;
  const publishers = ["a", "b"].map(
    (suffix) =>
      new Pool({
        ...getDatabaseConfig(testDatabaseUrl()),
        max: 1,
        application_name: `${tag}-${suffix}`,
      }),
  );
  try {
    const attempts = await Promise.all([
      publishSemanticModelRevision(publishers[0], scope(fixture)),
      publishSemanticModelRevision(publishers[1], scope(fixture)),
    ]);
    expect(attempts.map((result) => result.outcome).sort()).toEqual([
      "ALREADY_PUBLISHED",
      "PUBLISHED",
    ]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM app.semantic_model_revisions WHERE semantic_model_id=$1 AND status='PUBLISHED'",
          [fixture.modelId],
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await Promise.all(publishers.map((publisher) => publisher.end()));
  }
});

test("publications concorrentes de revisões diferentes do mesmo modelo são serializadas", async () => {
  const first = await makeDraft();
  expect(await publishSemanticModelRevision(pool, scope(first))).toMatchObject({
    outcome: "PUBLISHED",
  });
  const next = await makeDraft({
    datasetId: first.datasetId,
    versionNumber: 2,
    modelName: `publication_${sequence}`,
  });
  const publishers = [
    new Pool({ ...getDatabaseConfig(testDatabaseUrl()), max: 1 }),
    new Pool({ ...getDatabaseConfig(testDatabaseUrl()), max: 1 }),
  ];
  try {
    const [oldResult, nextResult] = await Promise.all([
      publishSemanticModelRevision(publishers[0], scope(first)),
      publishSemanticModelRevision(publishers[1], scope(next)),
    ]);
    expect(["ALREADY_PUBLISHED", "REVISION_NOT_DRAFT"]).toContain(
      oldResult.outcome,
    );
    expect(nextResult.outcome).toBe("PUBLISHED");
    const published = await pool.query<{ id: string }>(
      `SELECT id FROM app.semantic_model_revisions
       WHERE semantic_model_id=$1 AND status='PUBLISHED'`,
      [first.modelId],
    );
    expect(published.rows).toEqual([{ id: next.revisionId }]);
  } finally {
    await Promise.all(publishers.map((publisher) => publisher.end()));
  }
});
