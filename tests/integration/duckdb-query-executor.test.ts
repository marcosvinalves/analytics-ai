import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";
import { resolveAnalyticalSource } from "../../src/modules/dataset/application/resolve-analytical-source.ts";
import type { AuthorizedAnalyticalSource } from "../../src/modules/dataset/domain/analytical-source.ts";
import { executeCompiledQuery } from "../../src/modules/query/application/execute-compiled-query.ts";
import type {
  PhysicalQueryPlan,
  PlannedSourceField,
} from "../../src/modules/query/domain/physical-query-plan.ts";
import { compilePhysicalQuery } from "../../src/modules/query/infrastructure/duckdb-query-compiler.ts";
import { testDatabaseUrl } from "./helpers/database.ts";

vi.mock("server-only", () => ({}));

let pool: Pool;
let root: string;
let organizationId: string;
let workspaceId: string;
const datasetIds: string[] = [];

beforeAll(async () => {
  pool = new Pool(getDatabaseConfig(testDatabaseUrl()));
  root = await mkdtemp(path.join(os.tmpdir(), "query-executor-"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", root);
  organizationId = (
    await pool.query(
      "INSERT INTO app.organizations(name) VALUES ('Query executor') RETURNING id",
    )
  ).rows[0].id;
  workspaceId = (
    await pool.query(
      "INSERT INTO app.workspaces(organization_id,name) VALUES ($1,'Query executor') RETURNING id",
      [organizationId],
    )
  ).rows[0].id;
});

afterAll(async () => {
  try {
    await pool.query(
      "DELETE FROM app.dataset_columns WHERE dataset_version_id IN (SELECT v.id FROM app.dataset_versions v WHERE v.dataset_id = ANY($1::uuid[]))",
      [datasetIds],
    );
    await pool.query(
      "DELETE FROM app.dataset_versions WHERE dataset_id = ANY($1::uuid[])",
      [datasetIds],
    );
    await pool.query("DELETE FROM app.datasets WHERE id = ANY($1::uuid[])", [
      datasetIds,
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

type Column = { name: string; type: string; nullable: boolean | null };

async function fixture(csv: string, columns: Column[]) {
  const datasetId = (
    await pool.query(
      "INSERT INTO app.datasets(workspace_id,name) VALUES ($1,'Execution') RETURNING id",
      [workspaceId],
    )
  ).rows[0].id as string;
  datasetIds.push(datasetId);
  const datasetVersionId = randomUUID();
  const key = rawStorageKey(workspaceId, datasetVersionId);
  const filename = path.join(root, key);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, csv);
  const rowCount = csv.trimEnd().split("\n").length - 1;
  await pool.query(
    `INSERT INTO app.dataset_versions
      (id,dataset_id,version_number,source_type,storage_namespace,storage_key,status,row_count,column_count,processed_at,original_filename,size_bytes)
     VALUES($1,$2,1,'CSV','raw',$3,'READY',$4,$5,statement_timestamp(),'source.csv',$6)`,
    [
      datasetVersionId,
      datasetId,
      key,
      rowCount,
      columns.length,
      Buffer.byteLength(csv),
    ],
  );
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    await pool.query(
      `INSERT INTO app.dataset_columns
       (dataset_version_id,physical_name,inferred_type,ordinal_position,nullable,null_count)
       VALUES($1,$2,$3,$4,$5,0)`,
      [datasetVersionId, column.name, column.type, index + 1, column.nullable],
    );
  }
  const resolved = await resolveAnalyticalSource(pool, {
    workspaceId,
    datasetId,
    datasetVersionId,
  });
  if (resolved.outcome !== "RESOLVED") throw new Error(resolved.outcome);
  return { datasetId, datasetVersionId, filename, source: resolved.source };
}

function basePlan(source: AuthorizedAnalyticalSource): PhysicalQueryPlan {
  return {
    version: 1,
    context: {
      semanticModelId: "model",
      semanticModelRevisionId: "revision",
      datasetId: source.datasetId,
      datasetVersionId: source.datasetVersionId,
    },
    source: {
      kind: "CSV",
      material: source.material,
      materialIdentity: { ...source.materialIdentity },
      expectedSizeBytes: source.expectedSizeBytes,
      expectedRowCount: source.expectedRowCount,
      columns: source.schema.map(({ physicalName, ordinalPosition }) => ({
        physicalName,
        ordinalPosition,
      })),
      readMode: "TEXT",
      dialect: {
        encoding: "UTF-8",
        delimiter: ",",
        quote: '"',
        escape: '"',
        header: true,
        strict: true,
        emptyField: "NULL",
        quotedEmptyField: "NULL",
      },
      schemaValidation: {
        headerRequired: true,
        exactColumnCount: true,
        exactNamesAndOrder: true,
        duplicateNames: "ERROR",
        invalidRowShape: "ERROR",
        expectedRowCount: source.expectedRowCount,
      },
    },
    sourceFields: [],
    dimensions: [],
    metrics: [],
    filters: [],
    orderBy: [],
    output: [],
  };
}

const textField = (index: number, key: string): PlannedSourceField => ({
  fieldKey: key,
  columnIndex: index,
  semanticType: { kind: "STRING" },
  persistedPhysicalType: { family: "STRING", name: "VARCHAR" },
  compatibility: "EXECUTABLE_SAFE",
  conversion: {
    kind: "TEXT_IDENTITY",
    trim: false,
    normalizeUnicode: false,
    rejectNul: true,
    nulls: "PRESERVE",
  },
  resultType: { kind: "TEXT" },
});

function countByTextPlan(
  source: AuthorizedAnalyticalSource,
): PhysicalQueryPlan {
  const plan = basePlan(source);
  return {
    ...plan,
    sourceFields: [textField(0, "text")],
    dimensions: [
      {
        outputIndex: 0,
        expression: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 0,
          resultType: { kind: "TEXT" },
        },
        semanticType: { kind: "STRING" },
      },
    ],
    metrics: [
      {
        outputIndex: 1,
        semanticType: { kind: "INTEGER" },
        expression: {
          kind: "AGGREGATE",
          op: "COUNT",
          aggregationPolicy: "CARDINALITY",
          overflow: "ERROR",
          requireFiniteResult: false,
          resultType: { kind: "BIGINT" },
          expression: {
            kind: "SOURCE_FIELD",
            sourceFieldIndex: 0,
            resultType: { kind: "TEXT" },
          },
        },
      },
    ],
    orderBy: [{ outputIndex: 0, direction: "ASC", nulls: "LAST" }],
    output: [
      {
        outputIndex: 0,
        role: "DIMENSION",
        semanticKey: { kind: "FIELD", fieldKey: "text" },
        name: "text",
        label: "Text",
        semanticType: { kind: "STRING" },
        physicalType: { kind: "TEXT" },
      },
      {
        outputIndex: 1,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: "count" },
        name: "count",
        label: "Count",
        semanticType: { kind: "INTEGER" },
        physicalType: { kind: "BIGINT" },
      },
    ],
  };
}

function revenuePlan(
  source: AuthorizedAnalyticalSource,
  grouped: boolean,
): PhysicalQueryPlan {
  const plan = basePlan(source);
  const fields: PlannedSourceField[] = [
    textField(0, "city"),
    {
      fieldKey: "quantity",
      columnIndex: 1,
      semanticType: { kind: "INTEGER" },
      persistedPhysicalType: {
        family: "INTEGER",
        name: "BIGINT",
        decimalDigits: 19,
      },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_EXACT_INTEGER",
        fractionalValues: "ERROR",
        overflow: "ERROR",
        nulls: "PRESERVE",
      },
      resultType: { kind: "HUGEINT" },
    },
    {
      fieldKey: "unit_price",
      columnIndex: 2,
      semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
      persistedPhysicalType: {
        family: "DECIMAL",
        name: "DECIMAL(18,2)",
        precision: 18,
        scale: 2,
      },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_EXACT_DECIMAL",
        precision: 18,
        scale: 2,
        scientificNotation: "ERROR",
        rounding: "FORBIDDEN",
        truncation: "FORBIDDEN",
        overflow: "ERROR",
        nulls: "PRESERVE",
      },
      resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
    },
  ];
  const metricIndex = grouped ? 1 : 0;
  const metric: PhysicalQueryPlan["metrics"][number] = {
    outputIndex: metricIndex,
    semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
    expression: {
      kind: "AGGREGATE",
      op: "SUM",
      aggregationPolicy: "EXACT_DECIMAL",
      overflow: "ERROR",
      requireFiniteResult: false,
      resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
      expression: {
        kind: "BINARY",
        op: "MULTIPLY",
        arithmeticPolicy: "EXACT_DECIMAL",
        overflow: "ERROR",
        requireFiniteResult: false,
        resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        left: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 1,
          resultType: { kind: "HUGEINT" },
        },
        right: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 2,
          resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
        },
      },
    },
  };
  const metricOutput: PhysicalQueryPlan["output"][number] = {
    outputIndex: metricIndex,
    role: "METRIC",
    semanticKey: { kind: "METRIC", metricKey: "revenue" },
    name: "revenue",
    label: "Revenue",
    semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
    physicalType: { kind: "DECIMAL", precision: 38, scale: 2 },
  };
  return {
    ...plan,
    sourceFields: fields,
    dimensions: grouped
      ? [
          {
            outputIndex: 0,
            expression: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 0,
              resultType: { kind: "TEXT" },
            },
            semanticType: { kind: "STRING" },
          },
        ]
      : [],
    metrics: [metric],
    orderBy: grouped
      ? [{ outputIndex: 0, direction: "ASC", nulls: "LAST" }]
      : [],
    output: grouped
      ? [
          {
            outputIndex: 0,
            role: "DIMENSION",
            semanticKey: { kind: "FIELD", fieldKey: "city" },
            name: "city",
            label: "City",
            semanticType: { kind: "STRING" },
            physicalType: { kind: "TEXT" },
          },
          metricOutput,
        ]
      : [metricOutput],
  };
}

function allTypesPlan(source: AuthorizedAnalyticalSource): PhysicalQueryPlan {
  const base = basePlan(source);
  const fields: PlannedSourceField[] = [
    textField(0, "text"),
    {
      fieldKey: "integer",
      columnIndex: 1,
      semanticType: { kind: "INTEGER" },
      persistedPhysicalType: {
        family: "INTEGER",
        name: "HUGEINT",
        decimalDigits: 38,
      },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_EXACT_INTEGER",
        fractionalValues: "ERROR",
        overflow: "ERROR",
        nulls: "PRESERVE",
      },
      resultType: { kind: "HUGEINT" },
    },
    {
      fieldKey: "decimal",
      columnIndex: 2,
      semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
      persistedPhysicalType: {
        family: "DECIMAL",
        name: "DECIMAL(18,2)",
        precision: 18,
        scale: 2,
      },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_EXACT_DECIMAL",
        precision: 18,
        scale: 2,
        scientificNotation: "ERROR",
        rounding: "FORBIDDEN",
        truncation: "FORBIDDEN",
        overflow: "ERROR",
        nulls: "PRESERVE",
      },
      resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
    },
    {
      fieldKey: "number",
      columnIndex: 3,
      semanticType: { kind: "NUMBER" },
      persistedPhysicalType: { family: "NUMBER", name: "DOUBLE" },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_FINITE_DOUBLE",
        overflow: "ERROR",
        underflowToZero: "ERROR",
        nonFinite: "ERROR",
        nulls: "PRESERVE",
      },
      resultType: { kind: "DOUBLE" },
    },
    {
      fieldKey: "boolean",
      columnIndex: 4,
      semanticType: { kind: "BOOLEAN" },
      persistedPhysicalType: { family: "BOOLEAN", name: "BOOLEAN" },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_BOOLEAN",
        acceptedTokens: ["true", "false"],
        nulls: "PRESERVE",
      },
      resultType: { kind: "BOOLEAN" },
    },
    {
      fieldKey: "date",
      columnIndex: 5,
      semanticType: { kind: "DATE" },
      persistedPhysicalType: { family: "DATE", name: "DATE" },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_DATE",
        format: "YYYY-MM-DD",
        nulls: "PRESERVE",
      },
      resultType: { kind: "DATE" },
    },
    {
      fieldKey: "datetime",
      columnIndex: 6,
      semanticType: { kind: "DATETIME" },
      persistedPhysicalType: { family: "DATETIME", name: "TIMESTAMP" },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_DATETIME",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]",
        timezone: "FORBIDDEN",
        nulls: "PRESERVE",
      },
      resultType: { kind: "TIMESTAMP" },
    },
    {
      fieldKey: "instant",
      columnIndex: 7,
      semanticType: { kind: "INSTANT" },
      persistedPhysicalType: {
        family: "INSTANT",
        name: "TIMESTAMP WITH TIME ZONE",
      },
      compatibility: "EXECUTABLE_SAFE",
      conversion: {
        kind: "TEXT_TO_INSTANT",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z",
        timezone: "UTC_REQUIRED",
        nulls: "PRESERVE",
      },
      resultType: { kind: "TIMESTAMPTZ" },
    },
    textField(8, "nullable"),
  ];
  const dimensions = fields.map((field, outputIndex) => ({
    outputIndex,
    expression: {
      kind: "SOURCE_FIELD" as const,
      sourceFieldIndex: outputIndex,
      resultType: field.resultType,
    },
    semanticType: field.semanticType,
  }));
  const outputs: PhysicalQueryPlan["output"][number][] = fields.map(
    (field, outputIndex) => ({
      outputIndex,
      role: "DIMENSION",
      semanticKey: { kind: "FIELD", fieldKey: field.fieldKey },
      name: field.fieldKey,
      label: field.fieldKey,
      semanticType: field.semanticType,
      physicalType: field.resultType,
    }),
  );
  outputs.push({
    outputIndex: fields.length,
    role: "METRIC",
    semanticKey: { kind: "METRIC", metricKey: "count" },
    name: "count",
    label: "count",
    semanticType: { kind: "INTEGER" },
    physicalType: { kind: "BIGINT" },
  });
  return {
    ...base,
    sourceFields: fields,
    dimensions,
    metrics: [
      {
        outputIndex: fields.length,
        semanticType: { kind: "INTEGER" },
        expression: {
          kind: "AGGREGATE",
          op: "COUNT",
          aggregationPolicy: "CARDINALITY",
          overflow: "ERROR",
          requireFiniteResult: false,
          resultType: { kind: "BIGINT" },
          expression: {
            kind: "SOURCE_FIELD",
            sourceFieldIndex: 0,
            resultType: { kind: "TEXT" },
          },
        },
      },
    ],
    output: outputs,
  };
}

function compile(plan: PhysicalQueryPlan) {
  const result = compilePhysicalQuery(plan);
  if (result.outcome !== "COMPILED") throw new Error(result.outcome);
  return result.compiledQuery;
}

test("executes real T-018 plans with exact results, metadata, concurrency and no persistent mutation", async () => {
  const item = await fixture(
    "city,quantity,unit_price\nSP,2,1000.00\nRJ,1,59.61\nSP,3,\n",
    [
      { name: "city", type: "VARCHAR", nullable: false },
      { name: "quantity", type: "BIGINT", nullable: false },
      { name: "unit_price", type: "DECIMAL(18,2)", nullable: true },
    ],
  );
  const rawBefore = createHash("sha256")
    .update(await readFile(item.filename))
    .digest("hex");
  const metadataBefore = await pool.query(
    "SELECT status,row_count,column_count,updated_at FROM app.dataset_versions WHERE id=$1",
    [item.datasetVersionId],
  );
  const columnsBefore = await pool.query(
    "SELECT physical_name,inferred_type,ordinal_position,null_count FROM app.dataset_columns WHERE dataset_version_id=$1 ORDER BY ordinal_position",
    [item.datasetVersionId],
  );
  const [total, grouped, concurrent] = await Promise.all([
    executeCompiledQuery(compile(revenuePlan(item.source, false))),
    executeCompiledQuery(compile(revenuePlan(item.source, true))),
    executeCompiledQuery(compile(revenuePlan(item.source, false))),
  ]);
  expect(total).toEqual({
    outcome: "SUCCESS",
    result: {
      columns: [
        {
          key: "revenue",
          label: "Revenue",
          role: "METRIC",
          semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
        },
      ],
      rows: [[{ type: "DECIMAL", value: "2059.61" }]],
    },
  });
  expect(concurrent).toEqual(total);
  expect(grouped).toMatchObject({
    outcome: "SUCCESS",
    result: {
      rows: [
        [
          { type: "STRING", value: "RJ" },
          { type: "DECIMAL", value: "59.61" },
        ],
        [
          { type: "STRING", value: "SP" },
          { type: "DECIMAL", value: "2000.00" },
        ],
      ],
    },
  });
  if (total.outcome === "SUCCESS") {
    expect(Object.isFrozen(total.result)).toBe(true);
    expect(Object.isFrozen(total.result.rows[0][0])).toBe(true);
  }
  expect(
    createHash("sha256")
      .update(await readFile(item.filename))
      .digest("hex"),
  ).toBe(rawBefore);
  expect(
    (
      await pool.query(
        "SELECT status,row_count,column_count,updated_at FROM app.dataset_versions WHERE id=$1",
        [item.datasetVersionId],
      )
    ).rows,
  ).toEqual(metadataBefore.rows);
  expect(
    (
      await pool.query(
        "SELECT physical_name,inferred_type,ordinal_position,null_count FROM app.dataset_columns WHERE dataset_version_id=$1 ORDER BY ordinal_position",
        [item.datasetVersionId],
      )
    ).rows,
  ).toEqual(columnsBefore.rows);
});

test("enforces row and byte safety caps without partial results", async () => {
  const rows = Array.from(
    { length: 501 },
    (_, index) => `v${String(index).padStart(3, "0")}`,
  ).join("\n");
  const rowItem = await fixture(`text\n${rows}\n`, [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  await expect(
    executeCompiledQuery(compile(countByTextPlan(rowItem.source))),
  ).resolves.toEqual({ outcome: "RESULT_LIMIT_EXCEEDED" });

  const largeRows = Array.from(
    { length: 500 },
    (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(8400)}`,
  ).join("\n");
  const byteItem = await fixture(`text\n${largeRows}\n`, [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  await expect(
    executeCompiledQuery(compile(countByTextPlan(byteItem.source))),
  ).resolves.toEqual({ outcome: "RESULT_SIZE_LIMIT_EXCEEDED" });
});

test("serializes every supported result family from the real binding", async () => {
  const item = await fixture(
    "text,integer,decimal,number,boolean,date,datetime,instant,nullable\nação,9223372036854775808,-1.20,-0,true,2024-02-29,2024-01-02T03:04:05.123456,2024-01-02T03:04:05.123456Z,\n",
    [
      { name: "text", type: "VARCHAR", nullable: false },
      { name: "integer", type: "HUGEINT", nullable: false },
      { name: "decimal", type: "DECIMAL(18,2)", nullable: false },
      { name: "number", type: "DOUBLE", nullable: false },
      { name: "boolean", type: "BOOLEAN", nullable: false },
      { name: "date", type: "DATE", nullable: false },
      { name: "datetime", type: "TIMESTAMP", nullable: false },
      { name: "instant", type: "TIMESTAMP WITH TIME ZONE", nullable: false },
      { name: "nullable", type: "VARCHAR", nullable: true },
    ],
  );
  const result = await executeCompiledQuery(compile(allTypesPlan(item.source)));
  expect(result).toMatchObject({
    outcome: "SUCCESS",
    result: {
      rows: [
        [
          { type: "STRING", value: "ação" },
          { type: "INTEGER", value: "9223372036854775808" },
          { type: "DECIMAL", value: "-1.20" },
          { type: "NUMBER", value: "0" },
          { type: "BOOLEAN", value: true },
          { type: "DATE", value: "2024-02-29" },
          { type: "DATETIME", value: "2024-01-02T03:04:05.123456" },
          { type: "INSTANT", value: "2024-01-02T03:04:05.123456Z" },
          { type: "NULL" },
          { type: "INTEGER", value: "1" },
        ],
      ],
    },
  });
});

test("fails safely when material identity changed and preserves cancellation before execution", async () => {
  const item = await fixture("text\na\n", [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  const compiled = compile(countByTextPlan(item.source));
  await writeFile(item.filename, "text\nchanged\n");
  await expect(executeCompiledQuery(compiled)).resolves.toEqual({
    outcome: "SOURCE_INTEGRITY_FAILED",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeCompiledQuery(compiled, { signal: controller.signal }),
  ).resolves.toEqual({ outcome: "QUERY_CANCELLED" });
});

test("honors cancellation races for a trusted compiled capability", async () => {
  const item = await fixture("text\na\n", [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  const compiled = compile(countByTextPlan(item.source));
  const controller = new AbortController();
  const execution = executeCompiledQuery(compiled, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(execution).resolves.toEqual({ outcome: "QUERY_CANCELLED" });
});

test("interrupts active work on abort and detects material change during execution", async () => {
  const rows = Array.from(
    { length: 300_000 },
    (_, index) => `v${String(index).padStart(6, "0")}`,
  ).join("\n");
  const cancelItem = await fixture(`text\n${rows}\n`, [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  const cancelCompiled = compile(countByTextPlan(cancelItem.source));
  const controller = new AbortController();
  const cancelled = executeCompiledQuery(cancelCompiled, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await expect(cancelled).resolves.toEqual({ outcome: "QUERY_CANCELLED" });

  const changedItem = await fixture(`text\n${rows}\n`, [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  const changedCompiled = compile(countByTextPlan(changedItem.source));
  const changed = executeCompiledQuery(changedCompiled);
  const mutation = new Promise<void>((resolve, reject) =>
    setTimeout(
      () =>
        void writeFile(changedItem.filename, "text\nchanged\n").then(
          resolve,
          reject,
        ),
      10,
    ),
  );
  const [changedResult] = await Promise.all([changed, mutation]);
  expect(changedResult).toEqual({
    outcome: "SOURCE_INTEGRITY_FAILED",
  });
});

test("uses declared T-018 validation failure codes", async () => {
  const item = await fixture("text\na\n", [
    { name: "text", type: "VARCHAR", nullable: false },
  ]);
  const plan = countByTextPlan(item.source);
  const mismatched: PhysicalQueryPlan = {
    ...plan,
    source: {
      ...plan.source,
      expectedRowCount: BigInt(2),
      schemaValidation: {
        ...plan.source.schemaValidation,
        expectedRowCount: BigInt(2),
      },
    },
  };
  await expect(executeCompiledQuery(compile(mismatched))).resolves.toEqual({
    outcome: "SOURCE_SCHEMA_MISMATCH",
  });
});
