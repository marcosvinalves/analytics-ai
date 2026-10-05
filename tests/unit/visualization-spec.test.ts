import { expect, test, vi } from "vitest";
import type { QueryExplanation } from "../../src/modules/query/domain/query-explanation.ts";
import type { QueryResultColumn } from "../../src/modules/query/domain/query-result.ts";
import type {
  ResolvedDimension,
  ResolvedMetric,
  ResolvedOrder,
  ResolvedSemanticQuery,
} from "../../src/modules/query/domain/resolved-semantic-query.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";
import {
  MAX_VISUALIZATION_ISSUES,
  MAX_VISUALIZATION_SPEC_BYTES,
  parseVisualizationSpec,
  recommendVisualization,
  validateVisualizationCompatibility,
  type VisualizationCompatibilitySource,
  type VisualizationSpecV1,
} from "../../src/modules/dashboard/domain/visualization-spec.ts";

const keys = {
  string: "10000000-0000-4000-8000-000000000000",
  boolean: "11000000-0000-4000-8000-000000000000",
  integer: "12000000-0000-4000-8000-000000000000",
  decimal: "13000000-0000-4000-8000-000000000000",
  number: "14000000-0000-4000-8000-000000000000",
  date: "15000000-0000-4000-8000-000000000000",
  datetime: "16000000-0000-4000-8000-000000000000",
  instant: "17000000-0000-4000-8000-000000000000",
  metric2: "18000000-0000-4000-8000-000000000000",
  missing: "19000000-0000-4000-8000-000000000000",
} as const;

function field(key: string, semanticType: SemanticType): ResolvedDimension {
  return {
    field: {
      fieldKey: key,
      name: `field_${key.slice(0, 2)}`,
      label: `Field ${key.slice(0, 2)}`,
      semanticType,
      lineage: {
        physicalName: "must_not_be_used",
        physicalType: "VARCHAR",
        ordinalPosition: 1,
      },
    },
  };
}

function metric(key: string, resultType: SemanticType): ResolvedMetric {
  return {
    metricKey: key,
    name: `metric_${key.slice(0, 2)}`,
    label: `Metric ${key.slice(0, 2)}`,
    expression: {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: { kind: "literal", type: "INTEGER", value: "1" },
    },
    resultType,
    dependencies: [],
  };
}

function query(input?: {
  dimensions?: readonly ResolvedDimension[];
  metrics?: readonly ResolvedMetric[];
  orderBy?: readonly {
    role: "DIMENSION" | "METRIC";
    key: string;
    direction: "ASC" | "DESC";
  }[];
}): ResolvedSemanticQuery {
  const dimensions = input?.dimensions ?? [];
  const metrics = input?.metrics ?? [
    metric(keys.decimal, { kind: "DECIMAL", precision: 38, scale: 2 }),
  ];
  const orderBy: ResolvedOrder[] = (input?.orderBy ?? []).map((order) => {
    if (order.role === "DIMENSION") {
      const dimension = dimensions.find(
        (candidate) => candidate.field.fieldKey === order.key,
      );
      if (!dimension) throw new Error("Missing fixture dimension");
      return {
        target: { kind: "DIMENSION", dimension },
        direction: order.direction,
      };
    }
    const selectedMetric = metrics.find(
      (candidate) => candidate.metricKey === order.key,
    );
    if (!selectedMetric) throw new Error("Missing fixture metric");
    return {
      target: { kind: "METRIC", metric: selectedMetric },
      direction: order.direction,
    };
  });
  return {
    version: 1,
    model: { id: "20000000-0000-4000-8000-000000000000", name: "sales" },
    revision: {
      id: "21000000-0000-4000-8000-000000000000",
      revisionNumber: 1,
      label: "Published",
      publishedAt: new Date("2026-10-05T12:00:00Z"),
    },
    dataset: {
      id: "22000000-0000-4000-8000-000000000000",
      name: "sales",
    },
    datasetVersion: {
      id: "23000000-0000-4000-8000-000000000000",
      versionNumber: 1,
    },
    dimensions,
    metrics,
    filters: [],
    orderBy,
  };
}

function pre(value: ResolvedSemanticQuery): VisualizationCompatibilitySource {
  return { phase: "PRE_EXECUTION", query: value };
}

function post(
  value: ResolvedSemanticQuery,
  columns?: readonly QueryResultColumn[],
): Extract<VisualizationCompatibilitySource, { phase: "POST_EXECUTION" }> {
  return {
    phase: "POST_EXECUTION",
    columns: columns ?? [
      ...value.dimensions.map(({ field: item }) => ({
        key: item.fieldKey,
        label: item.label,
        role: "DIMENSION" as const,
        semanticType: item.semanticType,
      })),
      ...value.metrics.map((item) => ({
        key: item.metricKey,
        label: item.label,
        role: "METRIC" as const,
        semanticType: item.resultType,
      })),
    ],
    orderBy: value.orderBy.map((order) => ({
      target:
        order.target.kind === "DIMENSION"
          ? {
              role: "DIMENSION" as const,
              key: order.target.dimension.field.fieldKey,
              label: order.target.dimension.field.label,
            }
          : {
              role: "METRIC" as const,
              key: order.target.metric.metricKey,
              label: order.target.metric.label,
            },
      direction: order.direction,
      nulls: "LAST" as const,
    })) satisfies QueryExplanation["orderBy"],
  };
}

function parsed(input: unknown): VisualizationSpecV1 {
  const result = parseVisualizationSpec(input);
  if (!result.valid) throw new Error(JSON.stringify(result.error.issues));
  return result.spec;
}

function kpi(key: string = keys.decimal): VisualizationSpecV1 {
  return parsed({ version: 1, type: "KPI", value: { role: "METRIC", key } });
}

function bar(
  category: string = keys.string,
  value: string = keys.decimal,
): VisualizationSpecV1 {
  return parsed({
    version: 1,
    type: "BAR",
    category: { role: "DIMENSION", key: category },
    value: { role: "METRIC", key: value },
  });
}

function line(
  x: string = keys.date,
  y: string = keys.decimal,
): VisualizationSpecV1 {
  return parsed({
    version: 1,
    type: "LINE",
    x: { role: "DIMENSION", key: x },
    y: { role: "METRIC", key: y },
  });
}

test.each([undefined, null, true, 1, "KPI", []])(
  "parser rejeita raiz não objeto %#",
  (input) => {
    expect(parseVisualizationSpec(input)).toMatchObject({
      valid: false,
      error: {
        code: "INVALID_VISUALIZATION_SPEC",
        issues: [{ code: "INVALID_TYPE" }],
      },
    });
  },
);

test.each([
  [{ type: "TABLE" }, "MISSING_PROPERTY"],
  [{ version: "1", type: "TABLE" }, "INVALID_TYPE"],
  [{ version: 2, type: "TABLE" }, "UNSUPPORTED_VERSION"],
  [{ version: 1, type: "PIE" }, "INVALID_VISUALIZATION_TYPE"],
  [{ version: 1, type: "TABLE", extra: true }, "UNKNOWN_PROPERTY"],
])("parser rejeita contrato inválido %#", (input, code) => {
  expect(parseVisualizationSpec(input)).toMatchObject({
    valid: false,
    error: {
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    },
  });
});

test("parser exige shapes exatos por discriminante", () => {
  for (const input of [
    { version: 1, type: "KPI" },
    { version: 1, type: "TABLE", value: { role: "METRIC", key: keys.decimal } },
    {
      version: 1,
      type: "BAR",
      category: { role: "DIMENSION", key: keys.string },
    },
    { version: 1, type: "LINE", x: { role: "DIMENSION", key: keys.date } },
  ])
    expect(parseVisualizationSpec(input).valid).toBe(false);
});

test.each([
  [{ role: "VALUE", key: keys.decimal }, "INVALID_OUTPUT_ROLE"],
  [{ role: "METRIC", key: "invalid" }, "INVALID_KEY"],
  [
    { role: "METRIC", key: keys.decimal, label: "not allowed" },
    "UNKNOWN_PROPERTY",
  ],
])("parser rejeita referência inválida %#", (value, code) => {
  expect(
    parseVisualizationSpec({ version: 1, type: "KPI", value }),
  ).toMatchObject({
    valid: false,
    error: {
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    },
  });
});

test("normaliza UUID, canonicaliza, reconstrói e congela profundamente", () => {
  const input = {
    version: 1,
    type: "BAR",
    category: { role: "DIMENSION", key: keys.string.toUpperCase() },
    value: { role: "METRIC", key: keys.decimal.toUpperCase() },
  };
  const before = JSON.stringify(input);
  const result = parseVisualizationSpec(input);
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error("Expected valid spec");
  expect(result.spec).toEqual({
    version: 1,
    type: "BAR",
    category: { role: "DIMENSION", key: keys.string },
    value: { role: "METRIC", key: keys.decimal },
  });
  expect(result.spec).not.toBe(input);
  expect(result.spec.type === "BAR" && result.spec.category).not.toBe(
    input.category,
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.spec)).toBe(true);
  expect(result.spec.type === "BAR" && Object.isFrozen(result.spec.value)).toBe(
    true,
  );
  expect(result.canonicalJson).toBe(JSON.stringify(result.spec));
  expect(result.canonicalBytes).toBe(
    new TextEncoder().encode(result.canonicalJson).byteLength,
  );
  expect(result.canonicalBytes).toBeLessThan(MAX_VISUALIZATION_SPEC_BYTES);
  input.value.key = keys.missing;
  expect(JSON.stringify(input)).not.toBe(before);
  expect(result.spec.type === "BAR" && result.spec.value.key).toBe(
    keys.decimal,
  );
});

test("rejeita prototypes, getters, symbols e propriedades não enumeráveis", () => {
  const inherited = Object.create({ inherited: true });
  Object.assign(inherited, { version: 1, type: "TABLE" });
  const getter = { version: 1, type: "TABLE" };
  Object.defineProperty(getter, "value", { enumerable: true, get: () => 1 });
  const symbol = { version: 1, type: "TABLE", [Symbol("secret")]: true };
  const hidden = { version: 1, type: "TABLE" };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  for (const input of [inherited, getter, symbol, hidden])
    expect(parseVisualizationSpec(input)).toMatchObject({
      valid: false,
      error: { issues: [{ code: "INVALID_TYPE" }] },
    });
});

test("issues são seguras, determinísticas e limitadas", () => {
  const input = Object.fromEntries([
    ["version", 1],
    ["type", "KPI"],
    ["value", { role: "VALUE", key: "secret-key", extra: "secret-row" }],
    ...Array.from({ length: 50 }, (_, index) => [`extra${index}`, index]),
  ]);
  const first = parseVisualizationSpec(input);
  const second = parseVisualizationSpec(input);
  expect(first).toEqual(second);
  if (first.valid) throw new Error("Expected invalid spec");
  expect(first.error.issues.length).toBeLessThanOrEqual(
    MAX_VISUALIZATION_ISSUES,
  );
  expect(JSON.stringify(first.error.issues)).not.toContain("secret-row");
  expect(JSON.stringify(first.error.issues)).not.toContain("secret-key");
});

test.each([
  { kind: "INTEGER" },
  { kind: "DECIMAL", precision: 18, scale: 2 },
  { kind: "NUMBER" },
] as SemanticType[])("KPI aceita Metric numérica %#", (semanticType) => {
  const value = query({ metrics: [metric(keys.decimal, semanticType)] });
  expect(validateVisualizationCompatibility(kpi(), pre(value))).toEqual({
    compatible: true,
  });
  expect(validateVisualizationCompatibility(kpi(), post(value))).toEqual({
    compatible: true,
  });
});

test("KPI rejeita dimension, contagem, tipo e binding incompatíveis", () => {
  const dimension = field(keys.string, { kind: "STRING" });
  const withDimension = query({ dimensions: [dimension] });
  expect(
    validateVisualizationCompatibility(kpi(), pre(withDimension)),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_COUNT_INCOMPATIBLE" }),
    ]),
  });
  const twoMetrics = query({
    metrics: [
      metric(keys.decimal, { kind: "DECIMAL", precision: 18, scale: 2 }),
      metric(keys.metric2, { kind: "INTEGER" }),
    ],
  });
  expect(
    validateVisualizationCompatibility(kpi(), pre(twoMetrics)),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_COUNT_INCOMPATIBLE" }),
    ]),
  });
  const stringMetric = query({
    metrics: [metric(keys.decimal, { kind: "STRING" })],
  });
  expect(
    validateVisualizationCompatibility(kpi(), pre(stringMetric)),
  ).toMatchObject({
    compatible: false,
    issues: [expect.objectContaining({ code: "OUTPUT_TYPE_INCOMPATIBLE" })],
  });
  expect(
    validateVisualizationCompatibility(kpi(keys.missing), pre(query())),
  ).toMatchObject({
    compatible: false,
    issues: [expect.objectContaining({ code: "OUTPUT_NOT_FOUND" })],
  });
});

test("referência ausente não gera cascata de role ou type", () => {
  const result = validateVisualizationCompatibility(
    parsed({
      version: 1,
      type: "KPI",
      value: { role: "DIMENSION", key: keys.missing },
    }),
    pre(query()),
  );
  expect(result).toMatchObject({
    compatible: false,
    issues: [{ code: "OUTPUT_NOT_FOUND" }],
  });
});

test("role incorreto é distinguido de output ausente", () => {
  const result = validateVisualizationCompatibility(
    parsed({
      version: 1,
      type: "KPI",
      value: { role: "DIMENSION", key: keys.decimal },
    }),
    pre(query()),
  );
  expect(result).toMatchObject({
    compatible: false,
    issues: [{ code: "OUTPUT_ROLE_MISMATCH" }],
  });
});

test("TABLE aceita shapes variados sem limites próprios", () => {
  const dimensions = [
    field(keys.string, { kind: "STRING" }),
    field(keys.date, { kind: "DATE" }),
    field(keys.integer, { kind: "INTEGER" }),
  ];
  const metrics = [
    metric(keys.decimal, { kind: "DECIMAL", precision: 38, scale: 2 }),
    metric(keys.metric2, { kind: "INTEGER" }),
    metric(keys.number, { kind: "NUMBER" }),
    metric(keys.boolean, { kind: "BOOLEAN" }),
  ];
  const value = query({ dimensions, metrics });
  const spec = parsed({ version: 1, type: "TABLE" });
  expect(validateVisualizationCompatibility(spec, pre(value))).toEqual({
    compatible: true,
  });
  expect(validateVisualizationCompatibility(spec, post(value))).toEqual({
    compatible: true,
  });
  expect(
    validateVisualizationCompatibility(spec, {
      phase: "POST_EXECUTION",
      columns: [],
      orderBy: [],
    }),
  ).toMatchObject({
    compatible: false,
    issues: [{ code: "OUTPUT_COUNT_INCOMPATIBLE" }],
  });
});

test.each([
  ["STRING", keys.string],
  ["BOOLEAN", keys.boolean],
] as const)("BAR aceita dimension %s", (kind, key) => {
  const value = query({ dimensions: [field(key, { kind })] });
  expect(validateVisualizationCompatibility(bar(key), pre(value))).toEqual({
    compatible: true,
  });
  expect(validateVisualizationCompatibility(bar(key), post(value))).toEqual({
    compatible: true,
  });
});

test.each(["DATE", "DATETIME", "INSTANT", "INTEGER"] as const)(
  "BAR rejeita dimension %s",
  (kind) => {
    const value = query({ dimensions: [field(keys.string, { kind })] });
    expect(validateVisualizationCompatibility(bar(), pre(value))).toMatchObject(
      {
        compatible: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "OUTPUT_TYPE_INCOMPATIBLE" }),
        ]),
      },
    );
  },
);

test("BAR rejeita Metric não numérica, outputs extras e bindings incorretos", () => {
  const dimension = field(keys.string, { kind: "STRING" });
  const nonNumeric = query({
    dimensions: [dimension],
    metrics: [metric(keys.decimal, { kind: "BOOLEAN" })],
  });
  expect(
    validateVisualizationCompatibility(bar(), pre(nonNumeric)),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: "$.value",
        code: "OUTPUT_TYPE_INCOMPATIBLE",
      }),
    ]),
  });
  const extra = query({
    dimensions: [dimension, field(keys.boolean, { kind: "BOOLEAN" })],
  });
  expect(validateVisualizationCompatibility(bar(), pre(extra))).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_COUNT_INCOMPATIBLE" }),
    ]),
  });
  expect(
    validateVisualizationCompatibility(
      bar(keys.missing),
      pre(query({ dimensions: [dimension] })),
    ),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ path: "$.category", code: "OUTPUT_NOT_FOUND" }),
    ]),
  });
});

test.each([
  ["DATE", keys.date],
  ["DATETIME", keys.datetime],
  ["INSTANT", keys.instant],
] as const)("LINE aceita dimension %s ordenada ASC", (kind, key) => {
  const value = query({
    dimensions: [field(key, { kind })],
    orderBy: [{ role: "DIMENSION", key, direction: "ASC" }],
  });
  expect(validateVisualizationCompatibility(line(key), pre(value))).toEqual({
    compatible: true,
  });
  expect(validateVisualizationCompatibility(line(key), post(value))).toEqual({
    compatible: true,
  });
});

test("LINE rejeita tipo, ausência, DESC e dimension temporal em segunda posição", () => {
  const stringQuery = query({
    dimensions: [field(keys.date, { kind: "STRING" })],
  });
  expect(
    validateVisualizationCompatibility(line(), pre(stringQuery)),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_TYPE_INCOMPATIBLE" }),
    ]),
  });

  const dateDimension = field(keys.date, { kind: "DATE" });
  const absent = query({ dimensions: [dateDimension] });
  expect(validateVisualizationCompatibility(line(), pre(absent))).toMatchObject(
    {
      compatible: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER",
        }),
      ]),
    },
  );
  const descending = query({
    dimensions: [dateDimension],
    orderBy: [{ role: "DIMENSION", key: keys.date, direction: "DESC" }],
  });
  expect(
    validateVisualizationCompatibility(line(), pre(descending)),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER",
      }),
    ]),
  });
  const second = query({
    dimensions: [dateDimension],
    orderBy: [
      { role: "METRIC", key: keys.decimal, direction: "ASC" },
      { role: "DIMENSION", key: keys.date, direction: "ASC" },
    ],
  });
  expect(validateVisualizationCompatibility(line(), pre(second))).toMatchObject(
    {
      compatible: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER",
        }),
      ]),
    },
  );
});

test("LINE rejeita Metric não numérica", () => {
  const value = query({
    dimensions: [field(keys.date, { kind: "DATE" })],
    metrics: [metric(keys.decimal, { kind: "STRING" })],
    orderBy: [{ role: "DIMENSION", key: keys.date, direction: "ASC" }],
  });
  expect(validateVisualizationCompatibility(line(), pre(value))).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: "$.y",
        code: "OUTPUT_TYPE_INCOMPATIBLE",
      }),
    ]),
  });
});

test("PRE e POST usam a mesma matriz e columns são autoridade após execução", () => {
  const value = query({ dimensions: [field(keys.string, { kind: "STRING" })] });
  const spec = bar();
  expect(validateVisualizationCompatibility(spec, pre(value))).toEqual(
    validateVisualizationCompatibility(spec, post(value)),
  );
  const changedColumns =
    post(value).phase === "POST_EXECUTION"
      ? post(value).columns.map((column) =>
          column.role === "DIMENSION"
            ? { ...column, semanticType: { kind: "DATE" as const } }
            : column,
        )
      : [];
  expect(
    validateVisualizationCompatibility(spec, {
      phase: "POST_EXECUTION",
      columns: changedColumns,
      orderBy: [],
    }),
  ).toMatchObject({
    compatible: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "OUTPUT_TYPE_INCOMPATIBLE" }),
    ]),
  });
});

test("API POST não consulta rows", () => {
  const rows = vi.fn(() => {
    throw new Error("rows must not be read");
  });
  const result = {
    columns:
      post(query()).phase === "POST_EXECUTION" ? post(query()).columns : [],
    get rows() {
      return rows();
    },
  };
  expect(
    validateVisualizationCompatibility(kpi(), {
      phase: "POST_EXECUTION",
      columns: result.columns,
      orderBy: [],
    }),
  ).toEqual({ compatible: true });
  expect(rows).not.toHaveBeenCalled();
});

test("compatibility não muta inputs e congela seu resultado", () => {
  const value = query();
  const spec = kpi();
  const beforeQuery = JSON.stringify(value);
  const beforeSpec = JSON.stringify(spec);
  const result = validateVisualizationCompatibility(spec, pre(value));
  expect(JSON.stringify(value)).toBe(beforeQuery);
  expect(JSON.stringify(spec)).toBe(beforeSpec);
  expect(Object.isFrozen(result)).toBe(true);
});

test("recommendation retorna KPI, BAR, LINE e TABLE com reason estável", () => {
  const cases: readonly [ResolvedSemanticQuery, string, string][] = [
    [query(), "KPI", "SINGLE_NUMERIC_METRIC"],
    [
      query({ dimensions: [field(keys.string, { kind: "STRING" })] }),
      "BAR",
      "CATEGORICAL_DIMENSION_WITH_NUMERIC_METRIC",
    ],
    [
      query({
        dimensions: [field(keys.date, { kind: "DATE" })],
        orderBy: [{ role: "DIMENSION", key: keys.date, direction: "ASC" }],
      }),
      "LINE",
      "ORDERED_TEMPORAL_DIMENSION_WITH_NUMERIC_METRIC",
    ],
    [
      query({ dimensions: [field(keys.integer, { kind: "INTEGER" })] }),
      "TABLE",
      "UNIVERSAL_TABLE_FALLBACK",
    ],
  ];
  for (const [value, type, reason] of cases) {
    const recommendation = recommendVisualization(value);
    expect(recommendation).toMatchObject({ spec: { type }, reason });
    expect(
      validateVisualizationCompatibility(recommendation.spec, pre(value)),
    ).toEqual({ compatible: true });
    expect(Object.isFrozen(recommendation)).toBe(true);
    expect(Object.isFrozen(recommendation.spec)).toBe(true);
  }
});

test.each([
  ["DATE", keys.date],
  ["DATETIME", keys.datetime],
  ["INSTANT", keys.instant],
] as const)("recommendation LINE cobre %s", (kind, key) => {
  const value = query({
    dimensions: [field(key, { kind })],
    orderBy: [{ role: "DIMENSION", key, direction: "ASC" }],
  });
  expect(recommendVisualization(value).spec.type).toBe("LINE");
});

test("recommendation temporal sem order ou DESC usa TABLE", () => {
  const dimension = field(keys.date, { kind: "DATE" });
  expect(
    recommendVisualization(query({ dimensions: [dimension] })),
  ).toMatchObject({
    spec: { type: "TABLE" },
    reason: "UNIVERSAL_TABLE_FALLBACK",
  });
  expect(
    recommendVisualization(
      query({
        dimensions: [dimension],
        orderBy: [{ role: "DIMENSION", key: keys.date, direction: "DESC" }],
      }),
    ),
  ).toMatchObject({
    spec: { type: "TABLE" },
    reason: "UNIVERSAL_TABLE_FALLBACK",
  });
});

test("recommendation é determinística, pura e exclusivamente pré-execução", () => {
  const value = query({
    dimensions: [field(keys.boolean, { kind: "BOOLEAN" })],
  });
  const before = JSON.stringify(value);
  const first = recommendVisualization(value);
  const second = recommendVisualization(value);
  expect(first).toEqual(second);
  expect(JSON.stringify(value)).toBe(before);
  expect(first.spec.type).toBe("BAR");
});
