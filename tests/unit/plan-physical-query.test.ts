import { expect, test } from "vitest";
import type { AuthorizedAnalyticalSource } from "../../src/modules/dataset/domain/analytical-source.ts";
import { parsePhysicalType } from "../../src/modules/dataset/domain/physical-type.ts";
import { planPhysicalQuery } from "../../src/modules/query/domain/plan-physical-query.ts";
import type { ResolvedSemanticQuery } from "../../src/modules/query/domain/resolved-semantic-query.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const ids = {
  model: "10000000-0000-4000-8000-000000000000",
  revision: "20000000-0000-4000-8000-000000000000",
  dataset: "30000000-0000-4000-8000-000000000000",
  version: "40000000-0000-4000-8000-000000000000",
  city: "50000000-0000-4000-8000-000000000000",
  quantity: "51000000-0000-4000-8000-000000000000",
  price: "52000000-0000-4000-8000-000000000000",
  score: "53000000-0000-4000-8000-000000000000",
  revenue: "60000000-0000-4000-8000-000000000000",
  count: "61000000-0000-4000-8000-000000000000",
} as const;

function field(
  fieldKey: string,
  name: string,
  semanticType: SemanticType,
  physicalType: string,
  ordinalPosition: number,
) {
  return {
    fieldKey,
    name,
    label: `Label ${name}`,
    semanticType,
    lineage: { physicalName: name, physicalType, ordinalPosition },
  };
}

const city = field(ids.city, "city", { kind: "STRING" }, "VARCHAR", 1);
const quantity = field(
  ids.quantity,
  "quantity",
  { kind: "INTEGER" },
  "BIGINT",
  2,
);
const price = field(
  ids.price,
  "unit_price",
  { kind: "DECIMAL", precision: 18, scale: 2 },
  "DOUBLE",
  3,
);
const score = field(ids.score, "score", { kind: "NUMBER" }, "DOUBLE", 4);

function metricRevenue() {
  return {
    metricKey: ids.revenue,
    name: "revenue",
    label: "Revenue",
    expression: {
      version: 1 as const,
      kind: "aggregate" as const,
      op: "SUM" as const,
      expression: {
        kind: "binary" as const,
        op: "MULTIPLY" as const,
        left: { kind: "field" as const, fieldKey: ids.quantity },
        right: { kind: "field" as const, fieldKey: ids.price },
      },
    },
    resultType: { kind: "DECIMAL" as const, precision: 38, scale: 2 },
    dependencies: [quantity, price],
  };
}

function query(): ResolvedSemanticQuery {
  const revenue = metricRevenue();
  return {
    version: 1,
    model: { id: ids.model, name: "sales" },
    revision: {
      id: ids.revision,
      revisionNumber: 1,
      label: "Published",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    },
    dataset: { id: ids.dataset, name: "sales" },
    datasetVersion: { id: ids.version, versionNumber: 1 },
    metrics: [revenue],
    dimensions: [{ field: city }],
    filters: [
      {
        field: score,
        op: "EQ",
        value: { type: "NUMBER", value: "1e999999" },
      },
      { field: city, op: "IS_NOT_NULL" },
    ],
    orderBy: [
      {
        target: { kind: "DIMENSION", dimension: { field: city } },
        direction: "ASC",
      },
      {
        target: { kind: "METRIC", metric: revenue },
        direction: "DESC",
      },
    ],
    limit: 25,
  };
}

function source(
  overrides: Partial<AuthorizedAnalyticalSource> = {},
): AuthorizedAnalyticalSource {
  const definitions = [
    ["city", "VARCHAR"],
    ["quantity", "BIGINT"],
    ["unit_price", "DOUBLE"],
    ["score", "DOUBLE"],
    ["unused_time", "TIME"],
  ] as const;
  return {
    datasetId: ids.dataset,
    datasetVersionId: ids.version,
    sourceType: "CSV",
    material: Object.freeze({}),
    materialIdentity: {
      device: BigInt(1),
      inode: BigInt(2),
      sizeBytes: BigInt(100),
      modifiedTimeNs: BigInt(3),
    },
    expectedSizeBytes: BigInt(100),
    expectedRowCount: BigInt(20),
    schema: definitions.map(([physicalName, type], index) => ({
      physicalName,
      physicalType: parsePhysicalType(type)!,
      ordinalPosition: index + 1,
    })),
    ...overrides,
  } as unknown as AuthorizedAnalyticalSource;
}

function planned(
  resolved = query(),
  authorized = source(),
): Extract<ReturnType<typeof planPhysicalQuery>, { outcome: "PLANNED" }> {
  const result = planPhysicalQuery(resolved, authorized);
  if (result.outcome !== "PLANNED") throw new Error(result.outcome);
  return result;
}

test("plans CSV textual source without exposing its concrete path", () => {
  const result = planned();
  expect(result.plan.source).toMatchObject({
    kind: "CSV",
    readMode: "TEXT",
    expectedRowCount: BigInt(20),
    dialect: {
      emptyField: "NULL",
      quotedEmptyField: "NULL",
      strict: true,
    },
    schemaValidation: {
      headerRequired: true,
      exactColumnCount: true,
      exactNamesAndOrder: true,
      duplicateNames: "ERROR",
      invalidRowShape: "ERROR",
    },
  });
  expect(result.plan.source).not.toHaveProperty("absolutePath");
  expect(result.plan.source.material).not.toHaveProperty("absolutePath");
  expect(Object.keys(result.plan.source.material)).toEqual([]);
  expect(result.plan.source.columns).toHaveLength(5);
  expect(result.plan.sourceFields).toHaveLength(4);
  expect(
    result.plan.sourceFields.some((item) => item.fieldKey === "unused_time"),
  ).toBe(false);
});

test("plans DOUBLE metadata to exact DECIMAL directly from raw text", () => {
  const result = planned();
  const priceField = result.plan.sourceFields.find(
    (item) => item.fieldKey === ids.price,
  )!;
  expect(priceField).toMatchObject({
    persistedPhysicalType: { family: "NUMBER", name: "DOUBLE" },
    compatibility: "EXECUTABLE_EXPLICIT",
    conversion: {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: 18,
      scale: 2,
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
    },
    resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
  });
  expect(JSON.stringify(priceField)).not.toContain("DOUBLE_TO_DECIMAL");
});

test("plans INTEGER multiplied by DECIMAL as exact DECIMAL without choosing an intermediate cast", () => {
  const aggregate = planned().plan.metrics[0].expression;
  expect(aggregate).toMatchObject({
    op: "SUM",
    resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
    aggregationPolicy: "EXACT_DECIMAL",
    expression: {
      kind: "BINARY",
      op: "MULTIPLY",
      arithmeticPolicy: "EXACT_DECIMAL",
      resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
      overflow: "ERROR",
    },
  });
  expect(JSON.stringify(aggregate)).not.toContain("DECIMAL(38,0)");
});

test("preserves extreme NUMBER and declares finite-double capability without JS conversion", () => {
  const result = planned();
  expect(result.plan.filters[0]).toMatchObject({
    value: {
      value: "1e999999",
      resultType: { kind: "DOUBLE" },
      capability: {
        kind: "TEXT_TO_FINITE_DOUBLE",
        overflow: "ERROR",
        underflowToZero: "ERROR",
        nonFinite: "ERROR",
      },
    },
  });
  expect(
    result.plan.sourceFields.find((item) => item.fieldKey === ids.score),
  ).toMatchObject({
    conversion: { kind: "TEXT_TO_FINITE_DOUBLE" },
    resultType: { kind: "DOUBLE" },
  });
});

test("declares closed BOOLEAN, temporal, STRING and NULL policies", () => {
  const cases = [
    [
      "BOOLEAN",
      { kind: "BOOLEAN" } as const,
      { kind: "TEXT_TO_BOOLEAN", acceptedTokens: ["true", "false"] },
    ],
    [
      "DATE",
      { kind: "DATE" } as const,
      { kind: "TEXT_TO_DATE", format: "YYYY-MM-DD" },
    ],
    [
      "TIMESTAMP",
      { kind: "DATETIME" } as const,
      {
        kind: "TEXT_TO_DATETIME",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]",
        timezone: "FORBIDDEN",
      },
    ],
    [
      "TIMESTAMP WITH TIME ZONE",
      { kind: "INSTANT" } as const,
      {
        kind: "TEXT_TO_INSTANT",
        format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z",
        timezone: "UTC_REQUIRED",
      },
    ],
    [
      "VARCHAR",
      { kind: "STRING" } as const,
      {
        kind: "TEXT_IDENTITY",
        trim: false,
        normalizeUnicode: false,
        rejectNul: true,
      },
    ],
  ] as const;
  for (const [physical, semantic, expected] of cases) {
    const value = field(ids.city, "value", semantic, physical, 1);
    const countMetric = {
      metricKey: ids.count,
      name: "count_value",
      label: "Count",
      expression: {
        version: 1 as const,
        kind: "aggregate" as const,
        op: "COUNT" as const,
        expression: { kind: "field" as const, fieldKey: ids.city },
      },
      resultType: { kind: "INTEGER" as const },
      dependencies: [value],
    };
    const result = planned(
      {
        ...query(),
        metrics: [countMetric],
        dimensions: [],
        filters: [],
        orderBy: [],
      },
      source({
        schema: [
          {
            physicalName: "value",
            physicalType: parsePhysicalType(physical)!,
            ordinalPosition: 1,
          },
        ],
      }),
    );
    expect(result.plan.sourceFields[0].conversion).toMatchObject({
      ...expected,
      nulls: "PRESERVE",
    });
  }
});

test("preserves dimensions first, order output indexes, NULLS LAST and semantic limit", () => {
  const plan = planned().plan;
  expect(plan.output.map((item) => [item.role, item.outputIndex])).toEqual([
    ["DIMENSION", 0],
    ["METRIC", 1],
  ]);
  expect(plan.orderBy).toEqual([
    { outputIndex: 0, direction: "ASC", nulls: "LAST" },
    { outputIndex: 1, direction: "DESC", nulls: "LAST" },
  ]);
  expect(plan.semanticLimit).toBe(25);
  expect(plan.filters[1]).toMatchObject({ op: "IS_NOT_NULL" });
});

test.each([
  ["VARCHAR", { kind: "STRING" }, "TEXT_IDENTITY", "TEXT"],
  ["BOOLEAN", { kind: "BOOLEAN" }, "TEXT_TO_BOOLEAN", "BOOLEAN"],
  ["HUGEINT", { kind: "INTEGER" }, "TEXT_TO_EXACT_INTEGER", "HUGEINT"],
  [
    "DECIMAL(8,2)",
    { kind: "DECIMAL", precision: 10, scale: 2 },
    "TEXT_TO_EXACT_DECIMAL",
    "DECIMAL",
  ],
  ["DOUBLE", { kind: "NUMBER" }, "TEXT_TO_FINITE_DOUBLE", "DOUBLE"],
  ["DATE", { kind: "DATE" }, "TEXT_TO_DATE", "DATE"],
  ["TIMESTAMP", { kind: "DATETIME" }, "TEXT_TO_DATETIME", "TIMESTAMP"],
  [
    "TIMESTAMP WITH TIME ZONE",
    { kind: "INSTANT" },
    "TEXT_TO_INSTANT",
    "TIMESTAMPTZ",
  ],
  ["UUID", { kind: "STRING" }, "UUID_TEXT", "TEXT"],
] as const)(
  "%s to semantic %s has a closed conversion policy",
  (physical, semantic, conversion, resultType) => {
    const oneField = field(ids.city, "value", semantic, physical, 1);
    const countMetric = {
      metricKey: ids.count,
      name: "count_value",
      label: "Count",
      expression: {
        version: 1 as const,
        kind: "aggregate" as const,
        op: "COUNT" as const,
        expression: { kind: "field" as const, fieldKey: ids.city },
      },
      resultType: { kind: "INTEGER" as const },
      dependencies: [oneField],
    };
    const resolved = {
      ...query(),
      metrics: [countMetric],
      dimensions: [],
      filters: [],
      orderBy: [],
      limit: undefined,
    } as ResolvedSemanticQuery;
    const authorized = source({
      schema: [
        {
          physicalName: "value",
          physicalType: parsePhysicalType(physical)!,
          ordinalPosition: 1,
        },
      ],
    });
    const result = planned(resolved, authorized).plan;
    expect(result.sourceFields[0]).toMatchObject({
      conversion: { kind: conversion },
      resultType: { kind: resultType },
    });
    expect(result.metrics[0].expression).toMatchObject({
      op: "COUNT",
      resultType: { kind: "BIGINT" },
      aggregationPolicy: "CARDINALITY",
    });
  },
);

test("returns safe source errors for source type, IDs and lineage mismatch", () => {
  expect(planPhysicalQuery(query(), source({ sourceType: "PARQUET" }))).toEqual(
    { outcome: "UNSUPPORTED_SOURCE_TYPE" },
  );
  expect(planPhysicalQuery(query(), source({ datasetId: ids.model }))).toEqual({
    outcome: "SOURCE_MISMATCH",
  });
  const changed = source();
  const schema = changed.schema.map((column) =>
    column.ordinalPosition === 3
      ? { ...column, physicalName: "other_price" }
      : column,
  );
  expect(planPhysicalQuery(query(), source({ schema }))).toEqual({
    outcome: "SOURCE_MISMATCH",
  });
});

test("returns unsupported conversion without broadening T-011", () => {
  const invalidPrice = { ...price, semanticType: { kind: "BOOLEAN" } as const };
  const resolved = query();
  const changed: ResolvedSemanticQuery = {
    ...resolved,
    metrics: [
      {
        ...resolved.metrics[0],
        dependencies: [quantity, invalidPrice],
      },
    ],
  };
  expect(planPhysicalQuery(changed, source())).toEqual({
    outcome: "UNSUPPORTED_PHYSICAL_CONVERSION",
    fieldKey: ids.price,
  });
});

test("rejects adulterated dependencies and result type as internal inconsistency", () => {
  const resolved = query();
  expect(
    planPhysicalQuery(
      {
        ...resolved,
        metrics: [
          {
            ...resolved.metrics[0],
            dependencies: [quantity],
          },
        ],
      },
      source(),
    ),
  ).toMatchObject({ outcome: "INCONSISTENT_RESOLVED_QUERY" });
  expect(
    planPhysicalQuery(
      {
        ...resolved,
        metrics: [
          {
            ...resolved.metrics[0],
            resultType: { kind: "NUMBER" },
          },
        ],
      },
      source(),
    ),
  ).toMatchObject({ outcome: "INCONSISTENT_RESOLVED_QUERY" });
});

test("is deterministic, deeply frozen and does not mutate inputs", () => {
  const resolved = query();
  const authorized = source();
  const publishedAt = resolved.revision.publishedAt.getTime();
  const first = planned(resolved, authorized).plan;
  const second = planned(resolved, authorized).plan;
  expect(first).toEqual(second);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.metrics[0].expression)).toBe(true);
  expect(Object.isFrozen(first.sourceFields[0].conversion)).toBe(true);
  expect(resolved.revision.publishedAt.getTime()).toBe(publishedAt);
  expect(resolved).not.toHaveProperty("source");
});
