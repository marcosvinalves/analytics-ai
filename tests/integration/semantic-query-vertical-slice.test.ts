import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { runSemanticQuery } from "../../src/modules/query/application/run-semantic-query.ts";
import { createMetric } from "../../src/modules/semantic/infrastructure/metrics.ts";
import { createSemanticModelDraft } from "../../src/modules/semantic/infrastructure/create-semantic-model-draft.ts";
import { publishSemanticModelRevision } from "../../src/modules/semantic/infrastructure/semantic-publication.ts";
import { createSemanticField } from "../../src/modules/semantic/infrastructure/semantic-fields.ts";
import { resetTestDatabase, testDatabaseUrl } from "./helpers/database.ts";

vi.mock("server-only", () => ({}));

type OracleRow = Readonly<{
  date: string;
  city: string;
  quantity: bigint;
  priceCents: bigint;
}>;

type VerticalFixture = Readonly<{
  datasetId: string;
  datasetVersionId: string;
  semanticModelId: string;
  semanticModelRevisionId: string;
  rawPath: string;
  keys: Readonly<{
    date: string;
    city: string;
    quantity: string;
    unitPrice: string;
    revenue: string;
  }>;
}>;

const fixturePath = path.resolve(
  "tests/fixtures/query/vendas_teste_analytics_ai.csv",
);
const columnDefinitions = [
  ["data_venda", "DATE"],
  ["produto", "VARCHAR"],
  ["categoria", "VARCHAR"],
  ["cidade", "VARCHAR"],
  ["quantidade", "BIGINT"],
  ["preco_unitario", "DOUBLE"],
  ["receita", "DOUBLE"],
] as const;

let pool: Pool;
let storageRoot: string;
let organizationId: string;
let workspaceId: string;
let sequence = 0;

function cents(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)\.([0-9]{1,2})$/.exec(value);
  if (!match) throw new Error("Invalid fixture price");
  const magnitude =
    BigInt(match[2]) * BigInt(100) + BigInt(match[3].padEnd(2, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function oracleRows(csv: string): OracleRow[] {
  const lines = csv.trimEnd().split(/\r?\n/);
  if (
    lines.shift() !==
    "data_venda,produto,categoria,cidade,quantidade,preco_unitario,receita"
  )
    throw new Error("Unexpected fixture header");
  return lines.map((line) => {
    const values = line.split(",");
    if (values.length !== 7) throw new Error("Unexpected fixture row");
    return {
      date: values[0],
      city: values[3],
      quantity: BigInt(values[4]),
      priceCents: cents(values[5]),
    };
  });
}

function revenue(row: OracleRow): bigint {
  return row.quantity * row.priceCents;
}

function byCity(rows: readonly OracleRow[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows)
    totals.set(row.city, (totals.get(row.city) ?? BigInt(0)) + revenue(row));
  return totals;
}

function decimal(value: bigint): string {
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${(
    absolute % BigInt(100)
  )
    .toString()
    .padStart(2, "0")}`;
}

async function sha256(filename: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function createVerticalFixture(options?: {
  csv?: string;
  publish?: boolean;
}): Promise<VerticalFixture> {
  const number = ++sequence;
  const source = options?.csv ?? (await readFile(fixturePath, "utf8"));
  const datasetId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.datasets(workspace_id,name) VALUES($1,$2) RETURNING id",
      [workspaceId, `Vertical sales ${number}`],
    )
  ).rows[0].id;
  const datasetVersionId = randomUUID();
  const storageKey = rawStorageKey(workspaceId, datasetVersionId);
  const rawPath = path.join(storageRoot, storageKey);
  await mkdir(path.dirname(rawPath), { recursive: true });
  if (options?.csv === undefined) await copyFile(fixturePath, rawPath);
  else await writeFile(rawPath, source, "utf8");
  const rowCount = source.trimEnd().split(/\r?\n/).length - 1;
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,
       original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'vendas_teste_analytics_ai.csv',$4)`,
    [datasetVersionId, datasetId, storageKey, Buffer.byteLength(source)],
  );
  const columns = new Map<string, string>();
  for (let index = 0; index < columnDefinitions.length; index += 1) {
    const [name, type] = columnDefinitions[index];
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO app.dataset_columns
          (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
         VALUES($1,$2,$3,$4,NULL,0) RETURNING id`,
        [datasetVersionId, name, type, index + 1],
      )
    ).rows[0].id;
    columns.set(name, id);
  }
  await pool.query(
    `UPDATE app.dataset_versions
     SET status='READY',row_count=$2,column_count=$3,processed_at=statement_timestamp()
     WHERE id=$1`,
    [datasetVersionId, rowCount, columnDefinitions.length],
  );

  const draft = await createSemanticModelDraft(pool, {
    workspaceId,
    datasetId,
    datasetVersionId,
    modelName: `vertical_sales_${number}`,
    label: `Vertical sales ${number}`,
  });
  if (draft.outcome !== "CREATED") throw new Error("Expected semantic draft");
  const fieldKeys = new Map<string, string>();
  for (const field of [
    ["data_venda", "date", "Sale date", { kind: "DATE" as const }, false],
    ["cidade", "city", "City", { kind: "STRING" as const }, false],
    ["quantidade", "quantity", "Quantity", { kind: "INTEGER" as const }, false],
    [
      "preco_unitario",
      "unit_price",
      "Unit price",
      { kind: "DECIMAL" as const, precision: 18, scale: 2 },
      true,
    ],
  ] as const) {
    const created = await createSemanticField(pool, {
      workspaceId,
      semanticModelRevisionId: draft.revision.id,
      datasetColumnId: columns.get(field[0])!,
      name: field[1],
      label: field[2],
      semanticType: field[3],
      ...(field[4] ? { acceptExplicitConversion: true } : {}),
    });
    if (created.outcome !== "CREATED")
      throw new Error("Expected semantic field");
    fieldKeys.set(field[1], created.field.fieldKey);
  }
  const metric = await createMetric(pool, {
    workspaceId,
    semanticModelRevisionId: draft.revision.id,
    name: "revenue",
    label: "Revenue",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "MULTIPLY",
        left: { kind: "field", fieldKey: fieldKeys.get("quantity")! },
        right: { kind: "field", fieldKey: fieldKeys.get("unit_price")! },
      },
    },
  });
  if (metric.outcome !== "CREATED") throw new Error("Expected metric");
  if (options?.publish !== false) {
    const published = await publishSemanticModelRevision(pool, {
      workspaceId,
      semanticModelRevisionId: draft.revision.id,
    });
    if (published.outcome !== "PUBLISHED")
      throw new Error("Expected publication");
  }
  return {
    datasetId,
    datasetVersionId,
    semanticModelId: draft.model.id,
    semanticModelRevisionId: draft.revision.id,
    rawPath,
    keys: {
      date: fieldKeys.get("date")!,
      city: fieldKeys.get("city")!,
      quantity: fieldKeys.get("quantity")!,
      unitPrice: fieldKeys.get("unit_price")!,
      revenue: metric.metric.metricKey,
    },
  };
}

function queryInput(fixture: VerticalFixture, query: unknown) {
  return {
    workspaceId,
    semanticModelId: fixture.semanticModelId,
    query,
  };
}

async function metadataSnapshot(): Promise<unknown> {
  return (
    await pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
      'organizations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.organizations x),
      'workspaces',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.workspaces x),
      'datasets',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.datasets x),
      'dataset_versions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dataset_versions x),
      'dataset_columns',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.dataset_columns x),
      'semantic_models',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_models x),
      'semantic_model_revisions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_model_revisions x),
      'semantic_fields',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.semantic_fields x),
      'metrics',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM app.metrics x),
      'metric_field_references',(SELECT jsonb_agg(to_jsonb(x) ORDER BY metric_id,field_key) FROM app.metric_field_references x)
    ) AS state`)
  ).rows[0].state;
}

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  storageRoot = await mkdtemp(
    path.join(os.tmpdir(), "semantic-query-vertical-"),
  );
  vi.stubEnv("LOCAL_STORAGE_ROOT", storageRoot);
  organizationId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.organizations(name) VALUES('Vertical slice') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query<{ id: string }>(
      "INSERT INTO app.workspaces(organization_id,name) VALUES($1,'Vertical slice') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await pool?.end();
  await rm(storageRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
  await resetTestDatabase();
}, 30_000);

test("executa Revenue, Revenue by City e query filtrada no pipeline completo", async () => {
  const fixture = await createVerticalFixture();
  const csv = await readFile(fixturePath, "utf8");
  const rows = oracleRows(csv);
  const total = decimal(
    rows.reduce((sum, row) => sum + revenue(row), BigInt(0)),
  );
  const grouped = [...byCity(rows)].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const selectedCities = new Set(grouped.map(([city]) => city));
  const filtered = [
    ...byCity(
      rows.filter(
        (row) => row.date >= "2026-09-05" && selectedCities.has(row.city),
      ),
    ),
  ]
    .sort((left, right) =>
      left[1] === right[1]
        ? left[0].localeCompare(right[0])
        : left[1] > right[1]
          ? -1
          : 1,
    )
    .slice(0, 2);
  const metadataBefore = await metadataSnapshot();
  const hashBefore = await sha256(fixture.rawPath);

  const totalResult = await runSemanticQuery(
    pool,
    queryInput(fixture, { version: 1, metrics: [fixture.keys.revenue] }),
  );
  expect(total).toBe("2059.61");
  expect(totalResult).toMatchObject({
    outcome: "SUCCESS",
    execution: {
      result: {
        columns: [
          {
            key: fixture.keys.revenue,
            label: "Revenue",
            role: "METRIC",
            semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
          },
        ],
        rows: [[{ type: "DECIMAL", value: total }]],
      },
      explanation: {
        revision: { id: fixture.semanticModelRevisionId },
        datasetVersion: { id: fixture.datasetVersionId },
        metrics: [
          {
            metricKey: fixture.keys.revenue,
            numericSemantics: "EXACT",
            expression: {
              kind: "AGGREGATE",
              operator: "SUM",
              expression: {
                kind: "BINARY",
                operator: "MULTIPLY",
                left: {
                  kind: "FIELD",
                  fieldKey: fixture.keys.quantity,
                  label: "Quantity",
                },
                right: {
                  kind: "FIELD",
                  fieldKey: fixture.keys.unitPrice,
                  label: "Unit price",
                },
              },
            },
          },
        ],
      },
    },
  });
  if (totalResult.outcome !== "SUCCESS")
    throw new Error("Expected total result");
  const totalSerialized = JSON.stringify(totalResult.execution.explanation);
  for (const forbidden of [
    "DuckDB",
    "HUGEINT",
    "CAST",
    "physicalName",
    "raw.csv",
    "o0",
  ])
    expect(totalSerialized).not.toContain(forbidden);

  const groupedResult = await runSemanticQuery(
    pool,
    queryInput(fixture, {
      version: 1,
      metrics: [fixture.keys.revenue],
      dimensions: [fixture.keys.city],
      orderBy: [
        {
          target: { kind: "DIMENSION", fieldKey: fixture.keys.city },
          direction: "ASC",
        },
      ],
    }),
  );
  expect(groupedResult).toMatchObject({
    outcome: "SUCCESS",
    execution: {
      result: {
        columns: [
          {
            key: fixture.keys.city,
            role: "DIMENSION",
            semanticType: { kind: "STRING" },
          },
          {
            key: fixture.keys.revenue,
            role: "METRIC",
            semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
          },
        ],
        rows: grouped.map(([city, value]) => [
          { type: "STRING", value: city },
          { type: "DECIMAL", value: decimal(value) },
        ]),
      },
      explanation: {
        dimensions: [{ fieldKey: fixture.keys.city, label: "City" }],
        metrics: [{ metricKey: fixture.keys.revenue }],
      },
    },
  });

  const filteredResult = await runSemanticQuery(
    pool,
    queryInput(fixture, {
      version: 1,
      metrics: [fixture.keys.revenue],
      dimensions: [fixture.keys.city],
      filters: [
        {
          fieldKey: fixture.keys.date,
          op: "GTE",
          value: { type: "DATE", value: "2026-09-05" },
        },
        {
          fieldKey: fixture.keys.city,
          op: "IN",
          values: grouped.map(([city]) => ({ type: "STRING", value: city })),
        },
      ],
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: fixture.keys.revenue },
          direction: "DESC",
        },
      ],
      limit: 2,
    }),
  );
  expect(filteredResult).toMatchObject({
    outcome: "SUCCESS",
    execution: {
      result: {
        columns: [
          {
            key: fixture.keys.city,
            role: "DIMENSION",
            semanticType: { kind: "STRING" },
          },
          {
            key: fixture.keys.revenue,
            role: "METRIC",
            semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
          },
        ],
        rows: filtered.map(([city, value]) => [
          { type: "STRING", value: city },
          { type: "DECIMAL", value: decimal(value) },
        ]),
      },
      explanation: {
        filters: {
          combination: "AND",
          items: [{ operator: "GTE" }, { operator: "IN" }],
        },
        orderBy: [{ direction: "DESC", nulls: "LAST" }],
        semanticLimit: 2,
      },
    },
  });
  expect(filtered.map(([city, value]) => [city, decimal(value)])).toEqual([
    ["Taubaté", "578.50"],
    ["São José dos Campos", "386.38"],
  ]);

  const concurrent = await Promise.all([
    runSemanticQuery(
      pool,
      queryInput(fixture, {
        version: 1,
        metrics: [fixture.keys.revenue],
      }),
    ),
    runSemanticQuery(
      pool,
      queryInput(fixture, {
        version: 1,
        metrics: [fixture.keys.revenue],
      }),
    ),
  ]);
  expect(concurrent[0]).toEqual(concurrent[1]);
  expect(concurrent[0]).toMatchObject({ outcome: "SUCCESS" });
  expect(await metadataSnapshot()).toEqual(metadataBefore);
  expect(await sha256(fixture.rawPath)).toBe(hashBefore);
});

test("short-circuits invalid query, model fora do workspace e draft", async () => {
  const fixture = await createVerticalFixture();
  await expect(
    runSemanticQuery(
      pool,
      queryInput(fixture, { version: 1, metrics: [], sql: "SELECT 1" }),
    ),
  ).resolves.toMatchObject({ outcome: "INVALID_QUERY" });
  await expect(
    runSemanticQuery(pool, {
      workspaceId: randomUUID(),
      semanticModelId: fixture.semanticModelId,
      query: { version: 1, metrics: [fixture.keys.revenue] },
    }),
  ).resolves.toMatchObject({ outcome: "MODEL_NOT_FOUND" });
  const draft = await createVerticalFixture({ publish: false });
  await expect(
    runSemanticQuery(
      pool,
      queryInput(draft, { version: 1, metrics: [draft.keys.revenue] }),
    ),
  ).resolves.toMatchObject({ outcome: "MODEL_NOT_PUBLISHED" });
});

test("mapeia raw ausente e schema alterado para erros publicos seguros", async () => {
  const unavailable = await createVerticalFixture();
  await unlink(unavailable.rawPath);
  const missing = await runSemanticQuery(
    pool,
    queryInput(unavailable, {
      version: 1,
      metrics: [unavailable.keys.revenue],
    }),
  );
  expect(missing).toMatchObject({ outcome: "SOURCE_UNAVAILABLE" });

  const inconsistent = await createVerticalFixture();
  const bytes = await readFile(inconsistent.rawPath);
  const changed = bytes.toString("utf8").replace("data_venda", "data_falsa");
  expect(Buffer.byteLength(changed)).toBe(bytes.length);
  await writeFile(inconsistent.rawPath, changed, "utf8");
  const invalid = await runSemanticQuery(
    pool,
    queryInput(inconsistent, {
      version: 1,
      metrics: [inconsistent.keys.revenue],
    }),
  );
  expect(invalid).toMatchObject({ outcome: "SOURCE_INCONSISTENT" });
  const publicErrors = JSON.stringify([missing, invalid]);
  for (const forbidden of [
    storageRoot,
    "raw.csv",
    "storage_key",
    "physicalName",
    "DuckDB",
    "SELECT",
  ])
    expect(publicErrors).not.toContain(forbidden);
});

test("501 grupos excedem somente o safety result cap", async () => {
  const header =
    "data_venda,produto,categoria,cidade,quantidade,preco_unitario,receita";
  const rows = Array.from(
    { length: 501 },
    (_, index) =>
      `2026-09-01,Produto ${index},Categoria,Cidade ${index.toString().padStart(3, "0")},1,0.01,0.01`,
  );
  const fixture = await createVerticalFixture({
    csv: `${header}\n${rows.join("\n")}\n`,
  });
  await expect(
    runSemanticQuery(
      pool,
      queryInput(fixture, {
        version: 1,
        metrics: [fixture.keys.revenue],
        dimensions: [fixture.keys.city],
      }),
    ),
  ).resolves.toMatchObject({ outcome: "RESULT_LIMIT_EXCEEDED" });
});
