import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { readSemanticFieldReview } from "../../src/modules/semantic/infrastructure/read-semantic-field-review.ts";
import {
  createSemanticField,
  removeSemanticField,
  updateSemanticField,
} from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

let pool: Pool;
let workspaceId: string;
let otherWorkspaceId: string;
let storageDirectory: string;
let rawPath: string;
let rawHash: string;
let sequence = 0;

type Fixture = {
  datasetId: string;
  versionId: string;
  revisionId: string;
  columns: Record<string, string>;
};

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  const organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES ('Field review') RETURNING id",
    )
  ).rows[0].id;
  const workspaces = await pool.query<{ id: string }>(
    `INSERT INTO app.workspaces(organization_id,name)
     VALUES ($1,'Field review'),($1,'Other field review') RETURNING id`,
    [organizationId],
  );
  [workspaceId, otherWorkspaceId] = workspaces.rows.map((row) => row.id);
  storageDirectory = await mkdtemp(path.join(tmpdir(), "analytics-t034-"));
  rawPath = path.join(storageDirectory, "raw.csv");
  await writeFile(
    rawPath,
    "quantity,unit_price,sale_date\n2,10.50,2026-01-01\n",
  );
  rawHash = await sha256(rawPath);
});

afterAll(async () => {
  await pool?.end();
  if (storageDirectory)
    await rm(storageDirectory, { recursive: true, force: true });
  await resetTestDatabase();
}, 30_000);

async function fixture(): Promise<Fixture> {
  const current = ++sequence;
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,$2) RETURNING id",
      [workspaceId, `Field review ${current}`],
    )
  ).rows[0].id;
  const versionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key,status,
        row_count,column_count,processed_at,original_filename,size_bytes)
       VALUES ($1,1,'CSV','field-review',$2,'READY',1,3,statement_timestamp(),
        'raw.csv',$3) RETURNING id`,
      [datasetId, randomUUID(), (await readFile(rawPath)).byteLength],
    )
  ).rows[0].id;
  const columns: Record<string, string> = {};
  for (const [index, [name, type]] of [
    ["quantity", "BIGINT"],
    ["unit_price", "DOUBLE"],
    ["sale_date", "DATE"],
  ].entries()) {
    columns[name] = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
         (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
         VALUES ($1,$2,$3,$4,NULL,0) RETURNING id`,
        [versionId, name, type, index + 1],
      )
    ).rows[0].id;
  }
  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId: versionId,
    modelName: `field_review_${current}`,
    label: `Field review ${current}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected draft");
  return { datasetId, versionId, revisionId: draft.revision.id, columns };
}

test("reader usa a versão real do DRAFT, mantém ordem e é read-only", async () => {
  const first = await fixture();
  const secondVersion = (
    await pool.query<{ id: string }>(
      `INSERT INTO app.dataset_versions
       (dataset_id,version_number,source_type,storage_namespace,storage_key,status,
        row_count,column_count,processed_at)
       VALUES ($1,2,'CSV','field-review',$2,'READY',0,1,statement_timestamp())
       RETURNING id`,
      [first.datasetId, randomUUID()],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO app.dataset_columns
     (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
     VALUES ($1,'replacement','VARCHAR',1,NULL,0)`,
    [secondVersion],
  );
  const before = await pool.query(
    `SELECT r.updated_at,c.updated_at FROM app.semantic_model_revisions r
     CROSS JOIN app.dataset_columns c
     WHERE r.id=$1 AND c.dataset_version_id=$2 ORDER BY c.ordinal_position`,
    [first.revisionId, first.versionId],
  );
  const result = await readSemanticFieldReview(pool, {
    workspaceId,
    datasetId: first.datasetId,
  });
  expect(result).toMatchObject({
    outcome: "EDITABLE",
    review: {
      datasetVersion: { id: first.versionId, versionNumber: 1 },
      columns: [
        { physicalName: "quantity", proposedSemanticType: { kind: "INTEGER" } },
        {
          physicalName: "unit_price",
          proposedSemanticType: { kind: "NUMBER" },
        },
        { physicalName: "sale_date", proposedSemanticType: { kind: "DATE" } },
      ],
    },
  });
  expect(secondVersion).not.toBe(first.versionId);
  expect(
    await pool.query(
      `SELECT r.updated_at,c.updated_at FROM app.semantic_model_revisions r
       CROSS JOIN app.dataset_columns c
       WHERE r.id=$1 AND c.dataset_version_id=$2 ORDER BY c.ordinal_position`,
      [first.revisionId, first.versionId],
    ),
  ).toMatchObject({ rows: before.rows });
  expect(await sha256(rawPath)).toBe(rawHash);
});

test("workspace isolation e DRAFT obrigatório falham de forma segura", async () => {
  const current = await fixture();
  expect(
    await readSemanticFieldReview(pool, {
      workspaceId: otherWorkspaceId,
      datasetId: current.datasetId,
    }),
  ).toEqual({ outcome: "NOT_FOUND" });

  const quantity = await createSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    datasetColumnId: current.columns.quantity,
    name: "quantity",
    label: "Quantidade",
    semanticType: { kind: "INTEGER" },
  });
  if (quantity.outcome !== "CREATED") throw new Error("Expected field");
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    name: "total_quantity",
    label: "Quantidade total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: quantity.field.fieldKey },
    },
  });
  expect(metric.outcome).toBe("CREATED");
  expect(
    await publishSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
    }),
  ).toMatchObject({ outcome: "PUBLISHED" });
  expect(
    await readSemanticFieldReview(pool, {
      workspaceId,
      datasetId: current.datasetId,
    }),
  ).toEqual({ outcome: "NO_DRAFT" });
  expect(
    await updateSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
      semanticFieldId: quantity.field.id,
      changes: { label: "Outra" },
    }),
  ).toMatchObject({ outcome: "REVISION_NOT_EDITABLE", status: "PUBLISHED" });
});

test("CRUD preserva field_key, exige EXPLICIT e bloqueia remoção referenciada", async () => {
  const current = await fixture();
  const invalid = await createSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    datasetColumnId: current.columns.sale_date,
    name: "sale_date",
    label: "Data",
    semanticType: { kind: "DATETIME" },
  });
  expect(invalid.outcome).toBe("INCOMPATIBLE_TYPE");

  const explicitInput = {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    datasetColumnId: current.columns.unit_price,
    name: "unit_price",
    label: "Preço unitário",
    semanticType: { kind: "DECIMAL" as const, precision: 18, scale: 2 },
  };
  expect((await createSemanticField(pool, explicitInput)).outcome).toBe(
    "EXPLICIT_CONVERSION_REQUIRED",
  );
  const created = await createSemanticField(pool, {
    ...explicitInput,
    acceptExplicitConversion: true,
  });
  if (created.outcome !== "CREATED") throw new Error("Expected field");
  const updated = await updateSemanticField(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    semanticFieldId: created.field.id,
    changes: { label: "Preço", acceptExplicitConversion: true },
  });
  expect(updated).toMatchObject({
    outcome: "UPDATED",
    field: { id: created.field.id, fieldKey: created.field.fieldKey },
  });
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    name: "total_price",
    label: "Preço total",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: created.field.fieldKey },
    },
  });
  expect(metric.outcome).toBe("CREATED");
  expect(
    await removeSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: current.revisionId,
      semanticFieldId: created.field.id,
    }),
  ).toMatchObject({ outcome: "FIELD_IN_USE" });
  const reread = await readSemanticFieldReview(pool, {
    workspaceId,
    datasetId: current.datasetId,
  });
  expect(reread).toMatchObject({
    outcome: "EDITABLE",
    review: {
      columns: expect.arrayContaining([
        expect.objectContaining({
          physicalName: "unit_price",
          field: expect.objectContaining({ referencedByMetric: true }),
        }),
      ]),
    },
  });
  expect(await sha256(rawPath)).toBe(rawHash);
});

test("creates concorrentes convergem para um único campo", async () => {
  const current = await fixture();
  const input = {
    workspaceId,
    semanticModelRevisionId: current.revisionId,
    datasetColumnId: current.columns.quantity,
    name: "quantity",
    label: "Quantidade",
    semanticType: { kind: "INTEGER" as const },
  };
  const results = await Promise.all([
    createSemanticField(pool, input),
    createSemanticField(pool, input),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual([
    "CONFLICT",
    "CREATED",
  ]);
  expect(
    (
      await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM app.semantic_fields
         WHERE semantic_model_revision_id=$1 AND dataset_column_id=$2`,
        [current.revisionId, current.columns.quantity],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(await sha256(rawPath)).toBe(rawHash);
});
