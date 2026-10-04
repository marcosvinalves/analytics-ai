import { describe, expect, test } from "vitest";
import type { QueryResult } from "../../src/modules/query/domain/query-result.ts";
import { buildQueryExplanation } from "../../src/modules/query/domain/build-query-explanation.ts";
import type {
  ResolvedField,
  ResolvedMetric,
  ResolvedSemanticQuery,
} from "../../src/modules/query/domain/resolved-semantic-query.ts";

const ids = {
  model: "00000000-0000-4000-8000-000000000001",
  revision: "00000000-0000-4000-8000-000000000002",
  dataset: "00000000-0000-4000-8000-000000000003",
  version: "00000000-0000-4000-8000-000000000004",
  city: "00000000-0000-4000-8000-000000000005",
  quantity: "00000000-0000-4000-8000-000000000006",
  price: "00000000-0000-4000-8000-000000000007",
  date: "00000000-0000-4000-8000-000000000008",
  revenue: "00000000-0000-4000-8000-000000000009",
  count: "00000000-0000-4000-8000-000000000010",
  score: "00000000-0000-4000-8000-000000000011",
};

const city: ResolvedField = {
  fieldKey: ids.city,
  name: "city",
  label: "City",
  semanticType: { kind: "STRING" },
  lineage: {
    physicalName: "city_raw",
    physicalType: "VARCHAR",
    ordinalPosition: 1,
  },
};
const quantity: ResolvedField = {
  fieldKey: ids.quantity,
  name: "quantity",
  label: "Quantity",
  semanticType: { kind: "INTEGER" },
  lineage: {
    physicalName: "qty_raw",
    physicalType: "BIGINT",
    ordinalPosition: 2,
  },
};
const price: ResolvedField = {
  fieldKey: ids.price,
  name: "unit_price",
  label: "Unit price",
  semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
  lineage: {
    physicalName: "price_raw",
    physicalType: "DOUBLE",
    ordinalPosition: 3,
  },
};
const date: ResolvedField = {
  fieldKey: ids.date,
  name: "sale_date",
  label: "Sale date",
  semanticType: { kind: "DATE" },
  lineage: {
    physicalName: "date_raw",
    physicalType: "DATE",
    ordinalPosition: 4,
  },
};

function revenue(): ResolvedMetric {
  return {
    metricKey: ids.revenue,
    name: "revenue",
    label: "Revenue",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "MULTIPLY",
        left: { kind: "field", fieldKey: ids.quantity },
        right: { kind: "field", fieldKey: ids.price },
      },
    },
    resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
    dependencies: [quantity, price],
  };
}

function query(
  options: { grouped?: boolean; filtered?: boolean; limit?: number } = {},
): ResolvedSemanticQuery {
  const grouped = options.grouped ?? false;
  const metric = revenue();
  return {
    version: 1,
    model: { id: ids.model, name: "Sales" },
    revision: {
      id: ids.revision,
      revisionNumber: 4,
      label: "Published sales",
      publishedAt: new Date("2026-01-02T03:04:05.678Z"),
    },
    dataset: { id: ids.dataset, name: "Sales dataset" },
    datasetVersion: { id: ids.version, versionNumber: 7 },
    metrics: [metric],
    dimensions: grouped ? [{ field: city }] : [],
    filters: options.filtered
      ? [
          {
            field: date,
            op: "GTE",
            value: { type: "DATE", value: "2026-01-01" },
          },
          {
            field: city,
            op: "IN",
            values: [
              { type: "STRING", value: "São Paulo" },
              { type: "STRING", value: "Rio de Janeiro" },
            ],
          },
        ]
      : [],
    orderBy: grouped
      ? [
          {
            target: { kind: "DIMENSION", dimension: { field: city } },
            direction: "ASC",
          },
          { target: { kind: "METRIC", metric }, direction: "DESC" },
        ]
      : [],
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  };
}

function result(resolved: ResolvedSemanticQuery, rows = 1): QueryResult {
  const columns = [
    ...resolved.dimensions.map(({ field }) => ({
      key: field.fieldKey,
      label: field.label,
      role: "DIMENSION" as const,
      semanticType: field.semanticType,
    })),
    ...resolved.metrics.map((metric) => ({
      key: metric.metricKey,
      label: metric.label,
      role: "METRIC" as const,
      semanticType: metric.resultType,
    })),
  ];
  return {
    columns,
    rows: Array.from({ length: rows }, () =>
      columns.map((column) =>
        column.role === "DIMENSION"
          ? { type: "STRING" as const, value: "group" }
          : { type: "DECIMAL" as const, value: "2059.61" },
      ),
    ),
  };
}

function explained(resolved = query(), queryResult = result(resolved)) {
  const built = buildQueryExplanation({
    resolvedQuery: resolved,
    result: queryResult,
  });
  expect(built.outcome).toBe("EXPLAINED");
  if (built.outcome !== "EXPLAINED") throw new Error("not explained");
  return built.explanation;
}

test("explains Revenue semantically without copying its result value", () => {
  const explanation = explained();
  expect(explanation).toMatchObject({
    version: 1,
    model: { id: ids.model, name: "Sales" },
    revision: {
      id: ids.revision,
      revisionNumber: 4,
      publishedAt: "2026-01-02T03:04:05.678Z",
    },
    dataset: { id: ids.dataset, name: "Sales dataset" },
    datasetVersion: { id: ids.version, versionNumber: 7 },
    metrics: [
      {
        metricKey: ids.revenue,
        label: "Revenue",
        resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        numericSemantics: "EXACT",
        expression: {
          kind: "AGGREGATE",
          operator: "SUM",
          expression: {
            kind: "BINARY",
            operator: "MULTIPLY",
            left: { kind: "FIELD", fieldKey: ids.quantity, label: "Quantity" },
            right: { kind: "FIELD", fieldKey: ids.price, label: "Unit price" },
          },
        },
      },
    ],
    resultShape: { rowCount: 1, columnCount: 1 },
  });
  expect(JSON.stringify(explanation)).not.toContain("2059.61");
});

test("preserves grouped output and order semantics", () => {
  const resolved = query({ grouped: true });
  const explanation = explained(resolved, result(resolved, 2));
  expect(explanation.dimensions).toEqual([
    {
      fieldKey: ids.city,
      name: "city",
      label: "City",
      semanticType: { kind: "STRING" },
    },
  ]);
  expect(explanation.outputs.map(({ label }) => label)).toEqual([
    "City",
    "Revenue",
  ]);
  expect(explanation.orderBy).toEqual([
    {
      target: { role: "DIMENSION", key: ids.city, label: "City" },
      direction: "ASC",
      nulls: "LAST",
    },
    {
      target: { role: "METRIC", key: ids.revenue, label: "Revenue" },
      direction: "DESC",
      nulls: "LAST",
    },
  ]);
});

test("preserves filter order, typed values and implicit AND", () => {
  const resolved = query({ grouped: true, filtered: true });
  expect(explained(resolved, result(resolved)).filters).toEqual({
    combination: "AND",
    items: [
      {
        field: {
          fieldKey: ids.date,
          name: "sale_date",
          label: "Sale date",
          semanticType: { kind: "DATE" },
        },
        operator: "GTE",
        value: { semanticType: "DATE", value: "2026-01-01" },
      },
      {
        field: {
          fieldKey: ids.city,
          name: "city",
          label: "City",
          semanticType: { kind: "STRING" },
        },
        operator: "IN",
        values: [
          { semanticType: "STRING", value: "São Paulo" },
          { semanticType: "STRING", value: "Rio de Janeiro" },
        ],
      },
    ],
  });
});

test.each(["EQ", "NEQ", "GT", "GTE", "LT", "LTE"] as const)(
  "preserves the %s filter operator",
  (op) => {
    const base = query();
    const resolved: ResolvedSemanticQuery = {
      ...base,
      filters: [
        { field: date, op, value: { type: "DATE", value: "2026-01-01" } },
      ],
    };
    expect(explained(resolved).filters.items[0]).toMatchObject({
      operator: op,
    });
  },
);

test.each(["IS_NULL", "IS_NOT_NULL"] as const)(
  "preserves %s without inventing a literal",
  (op) => {
    const base = query();
    const resolved: ResolvedSemanticQuery = {
      ...base,
      filters: [{ field: city, op }],
    };
    expect(explained(resolved).filters.items[0]).toEqual({
      field: {
        fieldKey: ids.city,
        name: "city",
        label: "City",
        semanticType: { kind: "STRING" },
      },
      operator: op,
    });
  },
);

test("omits an absent semantic limit and preserves a present one without safety caps", () => {
  expect(explained()).not.toHaveProperty("semanticLimit");
  const resolved = query({ limit: 25 });
  const explanation = explained(resolved);
  expect(explanation.semanticLimit).toBe(25);
  expect(JSON.stringify(explanation)).not.toMatch(/MAX_RESULT|4194304|500/);
});

test("distinguishes exact INTEGER/DECIMAL from approximate NUMBER", () => {
  const base = query();
  const count: ResolvedMetric = {
    metricKey: ids.count,
    name: "count",
    label: "Count",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "COUNT",
      expression: { kind: "field", fieldKey: ids.city },
    },
    resultType: { kind: "INTEGER" },
    dependencies: [city],
  };
  const scoreField: ResolvedField = {
    ...quantity,
    fieldKey: ids.score,
    name: "score",
    label: "Score",
    semanticType: { kind: "NUMBER" },
  };
  const score: ResolvedMetric = {
    metricKey: ids.score,
    name: "score_sum",
    label: "Score sum",
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "field", fieldKey: ids.score },
    },
    resultType: { kind: "NUMBER" },
    dependencies: [scoreField],
  };
  const resolved: ResolvedSemanticQuery = {
    ...base,
    metrics: [count, revenue(), score],
  };
  const queryResult: QueryResult = {
    columns: [
      {
        key: ids.count,
        label: "Count",
        role: "METRIC",
        semanticType: { kind: "INTEGER" },
      },
      {
        key: ids.revenue,
        label: "Revenue",
        role: "METRIC",
        semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
      },
      {
        key: ids.score,
        label: "Score sum",
        role: "METRIC",
        semanticType: { kind: "NUMBER" },
      },
    ],
    rows: [
      [
        { type: "INTEGER", value: "1" },
        { type: "DECIMAL", value: "1.20" },
        { type: "NUMBER", value: "1.5" },
      ],
    ],
  };
  expect(
    explained(resolved, queryResult).metrics.map(
      ({ numericSemantics }) => numericSemantics,
    ),
  ).toEqual(["EXACT", "EXACT", "APPROXIMATE"]);
});

test.each(["COUNT", "COUNT_DISTINCT"] as const)(
  "explains %s without inventing COUNT(*)",
  (op) => {
    const base = query();
    const metric: ResolvedMetric = {
      metricKey: ids.count,
      name: "count",
      label: "Count",
      expression: {
        version: 1,
        kind: "aggregate",
        op,
        expression: { kind: "field", fieldKey: ids.city },
      },
      resultType: { kind: "INTEGER" },
      dependencies: [city],
    };
    const resolved: ResolvedSemanticQuery = { ...base, metrics: [metric] };
    const queryResult: QueryResult = {
      columns: [
        {
          key: ids.count,
          label: "Count",
          role: "METRIC",
          semanticType: { kind: "INTEGER" },
        },
      ],
      rows: [[{ type: "INTEGER", value: "1" }]],
    };
    expect(
      explained(resolved, queryResult).metrics[0].expression,
    ).toMatchObject({
      operator: op,
      expression: { kind: "FIELD", fieldKey: ids.city },
    });
  },
);

test.each([
  [
    "ADD",
    { kind: "literal", type: "INTEGER", value: "2" },
    { kind: "INTEGER" },
  ],
  [
    "SUBTRACT",
    { kind: "literal", type: "INTEGER", value: "2" },
    { kind: "INTEGER" },
  ],
] as const)(
  "translates %s and preserves INTEGER literals",
  (op, right, resultType) => {
    const base = query();
    const metric: ResolvedMetric = {
      metricKey: ids.count,
      name: "calculation",
      label: "Calculation",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: {
          kind: "binary",
          op,
          left: { kind: "field", fieldKey: ids.quantity },
          right,
        },
      },
      resultType,
      dependencies: [quantity],
    };
    const resolved: ResolvedSemanticQuery = { ...base, metrics: [metric] };
    const queryResult: QueryResult = {
      columns: [
        {
          key: ids.count,
          label: "Calculation",
          role: "METRIC",
          semanticType: resultType,
        },
      ],
      rows: [[{ type: "INTEGER", value: "3" }]],
    };
    expect(
      explained(resolved, queryResult).metrics[0].expression.expression,
    ).toMatchObject({
      kind: "BINARY",
      operator: op,
      right: { kind: "LITERAL", semanticType: "INTEGER", value: "2" },
    });
  },
);

test("preserves DECIMAL literal text in the explanation AST", () => {
  const base = query();
  const metric: ResolvedMetric = {
    ...revenue(),
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "ADD",
        left: { kind: "field", fieldKey: ids.price },
        right: { kind: "literal", type: "DECIMAL", value: "1.20" },
      },
    },
    dependencies: [price],
  };
  const resolved: ResolvedSemanticQuery = { ...base, metrics: [metric] };
  expect(explained(resolved).metrics[0].expression.expression).toMatchObject({
    right: { kind: "LITERAL", semanticType: "DECIMAL", value: "1.20" },
  });
});

test("rejects dependency and result type inconsistencies", () => {
  const base = query();
  const broken: ResolvedMetric = {
    ...revenue(),
    resultType: { kind: "NUMBER" },
    dependencies: [quantity],
  };
  const resolved: ResolvedSemanticQuery = { ...base, metrics: [broken] };
  const built = buildQueryExplanation({
    resolvedQuery: resolved,
    result: {
      columns: [
        {
          key: ids.revenue,
          label: "Revenue",
          role: "METRIC",
          semanticType: { kind: "NUMBER" },
        },
      ],
      rows: [],
    },
  });
  expect(built).toMatchObject({
    outcome: "INCONSISTENT_QUERY_ARTIFACTS",
    issues: [
      {
        path: "$.resolvedQuery.metrics[0].dependencies",
        code: "SEMANTIC_MISMATCH",
      },
      {
        path: "$.resolvedQuery.metrics[0].expression",
        code: "SEMANTIC_MISMATCH",
      },
    ],
  });
});

describe("QueryResult consistency", () => {
  test("rejects column count and semantic type mismatches", () => {
    const resolved = query();
    expect(
      buildQueryExplanation({
        resolvedQuery: resolved,
        result: { columns: [], rows: [] },
      }),
    ).toMatchObject({
      outcome: "INCONSISTENT_QUERY_ARTIFACTS",
      issues: [{ path: "$.result.columns", code: "RESULT_MISMATCH" }],
    });
    expect(
      buildQueryExplanation({
        resolvedQuery: resolved,
        result: {
          columns: [
            {
              ...result(resolved).columns[0],
              semanticType: { kind: "NUMBER" },
            },
          ],
          rows: [],
        },
      }),
    ).toMatchObject({
      outcome: "INCONSISTENT_QUERY_ARTIFACTS",
      issues: [{ path: "$.result.columns[0]", code: "RESULT_MISMATCH" }],
    });
  });

  test("rejects column count, order, metadata and semantic type mismatches", () => {
    const resolved = query({ grouped: true });
    const valid = result(resolved);
    const reversed: QueryResult = {
      columns: [...valid.columns].reverse(),
      rows: valid.rows,
    };
    const built = buildQueryExplanation({
      resolvedQuery: resolved,
      result: reversed,
    });
    expect(built.outcome).toBe("INCONSISTENT_QUERY_ARTIFACTS");
    if (built.outcome === "INCONSISTENT_QUERY_ARTIFACTS")
      expect(built.issues.map(({ path }) => path)).toEqual([
        "$.result.columns[0]",
        "$.result.columns[1]",
      ]);
  });

  test("rejects row width and non-null QueryValue tag mismatch", () => {
    const resolved = query();
    const built = buildQueryExplanation({
      resolvedQuery: resolved,
      result: {
        columns: result(resolved).columns,
        rows: [[], [{ type: "NUMBER", value: "1" }]],
      },
    });
    expect(built).toMatchObject({
      outcome: "INCONSISTENT_QUERY_ARTIFACTS",
      issues: [
        { path: "$.result.rows[0]", code: "RESULT_MISMATCH" },
        { path: "$.result.rows[1][0]", code: "RESULT_MISMATCH" },
      ],
    });
  });

  test("accepts NULL for every semantic output", () => {
    const resolved = query({ grouped: true });
    const queryResult: QueryResult = {
      columns: result(resolved).columns,
      rows: [[{ type: "NULL" }, { type: "NULL" }]],
    };
    expect(
      buildQueryExplanation({ resolvedQuery: resolved, result: queryResult })
        .outcome,
    ).toBe("EXPLAINED");
  });
});

test("rejects orderBy targets that do not match a selected semantic output", () => {
  const base = query();
  const other = { ...revenue(), metricKey: ids.count, label: "Other" };
  const resolved: ResolvedSemanticQuery = {
    ...base,
    orderBy: [
      {
        target: { kind: "METRIC", metric: other },
        direction: "ASC",
      },
    ],
  };
  expect(
    buildQueryExplanation({
      resolvedQuery: resolved,
      result: result(resolved),
    }),
  ).toMatchObject({
    outcome: "INCONSISTENT_QUERY_ARTIFACTS",
    issues: [
      {
        path: "$.resolvedQuery.orderBy[0].target",
        code: "SEMANTIC_MISMATCH",
      },
    ],
  });
});

test("caps issues deterministically", () => {
  const resolved = query();
  const queryResult: QueryResult = {
    columns: result(resolved).columns,
    rows: Array.from({ length: 20 }, () => []),
  };
  const built = buildQueryExplanation({
    resolvedQuery: resolved,
    result: queryResult,
  });
  expect(built.outcome).toBe("INCONSISTENT_QUERY_ARTIFACTS");
  if (built.outcome !== "INCONSISTENT_QUERY_ARTIFACTS") return;
  expect(built.issues).toHaveLength(16);
  expect(built.issues.at(-1)).toEqual({
    path: "$",
    code: "ISSUE_LIMIT_REACHED",
    message: "Existem inconsistencias adicionais nao listadas.",
  });
});

test("reconstructs, deep-freezes and deterministically preserves inputs", () => {
  const resolved = query({ grouped: true, filtered: true, limit: 10 });
  const queryResult = result(resolved);
  const dateBefore = resolved.revision.publishedAt.getTime();
  const first = buildQueryExplanation({
    resolvedQuery: resolved,
    result: queryResult,
  });
  const second = buildQueryExplanation({
    resolvedQuery: resolved,
    result: queryResult,
  });
  expect(first).toEqual(second);
  expect(resolved.revision.publishedAt.getTime()).toBe(dateBefore);
  expect(queryResult.rows[0][0]).toEqual({ type: "STRING", value: "group" });
  if (first.outcome !== "EXPLAINED") return;
  expect(Object.isFrozen(first.explanation)).toBe(true);
  expect(
    Object.isFrozen(first.explanation.metrics[0].expression.expression),
  ).toBe(true);
  expect(first.explanation.metrics[0].dependencies[0]).not.toBe(
    resolved.metrics[0].dependencies[0],
  );
});

test("does not expose physical or execution internals", () => {
  const serialized = JSON.stringify(
    explained(query({ grouped: true, filtered: true })),
  );
  for (const forbidden of [
    "physicalName",
    "physicalType",
    "city_raw",
    "qty_raw",
    "price_raw",
    "DuckDB",
    "SELECT",
    "raw.csv",
    "storage_namespace",
    "storage_key",
    "materialIdentity",
    "__t018_source",
    '"sql"',
    '"rows"',
    '"o0"',
    "CAST",
  ])
    expect(serialized).not.toContain(forbidden);
});
