import { expect, test } from "vitest";
import type { SemanticModelInspection } from "../../src/modules/semantic/domain/semantic-inspection.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";
import { resolveSemanticQuery } from "../../src/modules/query/domain/resolve-semantic-query.ts";
import {
  MAX_SEMANTIC_RESOLUTION_ISSUES,
  type ResolvedSemanticQuery,
} from "../../src/modules/query/domain/resolved-semantic-query.ts";
import {
  parseSemanticQuery,
  type SemanticLiteral,
  type SemanticQueryV1,
} from "../../src/modules/query/domain/semantic-query.ts";

const ids = {
  model: "10000000-0000-4000-8000-000000000000",
  revision: "20000000-0000-4000-8000-000000000000",
  dataset: "30000000-0000-4000-8000-000000000000",
  version: "40000000-0000-4000-8000-000000000000",
  city: "50000000-0000-4000-8000-000000000000",
  active: "51000000-0000-4000-8000-000000000000",
  quantity: "52000000-0000-4000-8000-000000000000",
  price: "53000000-0000-4000-8000-000000000000",
  score: "54000000-0000-4000-8000-000000000000",
  date: "55000000-0000-4000-8000-000000000000",
  datetime: "56000000-0000-4000-8000-000000000000",
  instant: "57000000-0000-4000-8000-000000000000",
  revenue: "60000000-0000-4000-8000-000000000000",
  count: "61000000-0000-4000-8000-000000000000",
  unknownMetric: "70000000-0000-4000-8000-000000000000",
  unknownField: "71000000-0000-4000-8000-000000000000",
} as const;

const fieldDefinitions: readonly [string, string, SemanticType, string][] = [
  [ids.city, "city", { kind: "STRING" }, "VARCHAR"],
  [ids.active, "active", { kind: "BOOLEAN" }, "BOOLEAN"],
  [ids.quantity, "quantity", { kind: "INTEGER" }, "BIGINT"],
  [
    ids.price,
    "unit_price",
    { kind: "DECIMAL", precision: 18, scale: 2 },
    "DOUBLE",
  ],
  [ids.score, "score", { kind: "NUMBER" }, "DOUBLE"],
  [ids.date, "sale_date", { kind: "DATE" }, "DATE"],
  [ids.datetime, "created_local", { kind: "DATETIME" }, "TIMESTAMP"],
  [ids.instant, "created_at", { kind: "INSTANT" }, "TIMESTAMP WITH TIME ZONE"],
];

function inspection(
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" = "PUBLISHED",
): SemanticModelInspection {
  return {
    model: { id: ids.model, name: "sales" },
    revision: {
      id: ids.revision,
      revisionNumber: 2,
      status,
      label: "Published sales",
      description: "must not be copied",
      createdAt: new Date("2026-09-28T10:00:00.000Z"),
      publishedAt:
        status === "DRAFT" ? null : new Date("2026-09-28T12:00:00.000Z"),
    },
    dataset: { id: ids.dataset, name: "vendas" },
    datasetVersion: { id: ids.version, versionNumber: 3, status: "READY" },
    fields: fieldDefinitions.map(
      ([fieldKey, name, semanticType, physicalType], index) => ({
        fieldKey,
        name,
        label: `Label ${name}`,
        description: "must not be copied",
        semanticType,
        lineage: {
          physicalName: name,
          physicalType,
          ordinalPosition: index + 1,
        },
      }),
    ),
    metrics: [
      {
        metricKey: ids.revenue,
        name: "total_revenue",
        label: "Total revenue",
        description: "must not be copied",
        expression: {
          version: 1,
          kind: "aggregate",
          op: "SUM",
          expression: { kind: "field", fieldKey: ids.price },
        },
        resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        dependencies: [ids.price],
      },
      {
        metricKey: ids.count,
        name: "city_count",
        label: "City count",
        description: null,
        expression: {
          version: 1,
          kind: "aggregate",
          op: "COUNT_DISTINCT",
          expression: { kind: "field", fieldKey: ids.city },
        },
        resultType: { kind: "INTEGER" },
        dependencies: [ids.city],
      },
    ],
  };
}

function query(extra: Record<string, unknown> = {}): SemanticQueryV1 {
  const result = parseSemanticQuery({
    version: 1,
    metrics: [ids.revenue],
    ...extra,
  });
  if (!result.valid) throw new Error(JSON.stringify(result.error.issues));
  return result.query;
}

function resolved(
  semanticQuery: SemanticQueryV1,
  snapshot = inspection(),
): ResolvedSemanticQuery {
  const result = resolveSemanticQuery(semanticQuery, snapshot);
  if (result.outcome !== "RESOLVED") throw new Error(result.outcome);
  return result.query;
}

test("resolve contexto, metrics, dimensions e dependencies sem copiar descriptions", () => {
  const result = resolved(
    query({
      metrics: [ids.count, ids.revenue],
      dimensions: [ids.price, ids.city],
    }),
  );
  expect(result).toMatchObject({
    version: 1,
    model: { id: ids.model, name: "sales" },
    revision: {
      id: ids.revision,
      revisionNumber: 2,
      label: "Published sales",
    },
    dataset: { id: ids.dataset, name: "vendas" },
    datasetVersion: { id: ids.version, versionNumber: 3 },
  });
  expect(result.dimensions.map((item) => item.field.fieldKey)).toEqual([
    ids.price,
    ids.city,
  ]);
  expect(result.metrics.map((item) => item.metricKey)).toEqual([
    ids.count,
    ids.revenue,
  ]);
  expect(result.metrics[1].dependencies[0]).toBe(result.dimensions[0].field);
  expect(result.metrics[0]).not.toHaveProperty("description");
  expect(result.dimensions[0].field).not.toHaveProperty("description");
  expect(result.revision).not.toHaveProperty("description");
});

test.each(["DRAFT", "ARCHIVED"] as const)(
  "rejeita revision %s para execucao",
  (status) => {
    expect(resolveSemanticQuery(query(), inspection(status))).toEqual({
      outcome: "REVISION_NOT_PUBLISHED",
      status,
    });
  },
);

test("reporta metrics e dimensions desconhecidas na ordem da query", () => {
  const result = resolveSemanticQuery(
    query({
      metrics: [ids.unknownMetric, ids.revenue],
      dimensions: [ids.unknownField, ids.quantity],
    }),
    inspection(),
  );
  expect(result).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [
      { path: "$.metrics[0]", code: "UNKNOWN_METRIC" },
      { path: "$.dimensions[0]", code: "UNKNOWN_FIELD" },
    ],
  });
});

test("permite qualquer SemanticField, inclusive numerico, como dimension", () => {
  const result = resolved(query({ dimensions: [ids.quantity, ids.score] }));
  expect(result.dimensions.map((item) => item.field.semanticType.kind)).toEqual(
    ["INTEGER", "NUMBER"],
  );
  expect(result.dimensions[0].field.lineage).toEqual({
    physicalName: "quantity",
    physicalType: "BIGINT",
    ordinalPosition: 3,
  });
});

const exactLiterals: readonly [string, SemanticLiteral][] = [
  [ids.city, { type: "STRING", value: "São Paulo" }],
  [ids.active, { type: "BOOLEAN", value: true }],
  [ids.quantity, { type: "INTEGER", value: "123" }],
  [ids.price, { type: "DECIMAL", value: "19.90" }],
  [ids.score, { type: "NUMBER", value: "1.5e2" }],
  [ids.date, { type: "DATE", value: "2026-09-28" }],
  [ids.datetime, { type: "DATETIME", value: "2026-09-28T12:00:00" }],
  [ids.instant, { type: "INSTANT", value: "2026-09-28T15:00:00Z" }],
];

test.each(exactLiterals)(
  "aceita EQ, NEQ e IN com correspondencia exata para %s",
  (fieldKey, literal) => {
    for (const filter of [
      { fieldKey, op: "EQ", value: literal },
      { fieldKey, op: "NEQ", value: literal },
      { fieldKey, op: "IN", values: [literal] },
    ]) {
      const result = resolveSemanticQuery(
        query({ filters: [filter] }),
        inspection(),
      );
      expect(result.outcome).toBe("RESOLVED");
    }
  },
);

test.each([
  [ids.quantity, { type: "INTEGER", value: "1" }],
  [ids.price, { type: "DECIMAL", value: "1.00" }],
  [ids.score, { type: "NUMBER", value: "1" }],
  [ids.date, { type: "DATE", value: "2026-09-28" }],
  [ids.datetime, { type: "DATETIME", value: "2026-09-28T12:00:00" }],
  [ids.instant, { type: "INSTANT", value: "2026-09-28T12:00:00Z" }],
] as const)("aceita comparacoes ordenadas para %s", (fieldKey, literal) => {
  for (const op of ["GT", "GTE", "LT", "LTE"] as const)
    expect(
      resolveSemanticQuery(
        query({ filters: [{ fieldKey, op, value: literal }] }),
        inspection(),
      ).outcome,
    ).toBe("RESOLVED");
});

test.each([
  [ids.city, { type: "STRING", value: "x" }],
  [ids.active, { type: "BOOLEAN", value: true }],
] as const)("rejeita ordering para STRING/BOOLEAN %s", (fieldKey, literal) => {
  expect(
    resolveSemanticQuery(
      query({ filters: [{ fieldKey, op: "GT", value: literal }] }),
      inspection(),
    ),
  ).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [{ path: "$.filters[0].op", code: "INCOMPATIBLE_FILTER" }],
  });
});

test("exige correspondencia estrita sem coercoes", () => {
  const result = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.price,
          op: "EQ",
          value: { type: "INTEGER", value: "19" },
        },
        {
          fieldKey: ids.date,
          op: "EQ",
          value: { type: "STRING", value: "2026-09-28" },
        },
      ],
    }),
    inspection(),
  );
  expect(result).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [
      { path: "$.filters[0].value", code: "INCOMPATIBLE_FILTER" },
      { path: "$.filters[1].value", code: "INCOMPATIBLE_FILTER" },
    ],
  });
});

test.each([
  ["19.90", true],
  ["0.00", true],
  ["1234567890123456.78", true],
  ["19.999", false],
  ["12345678901234567.89", false],
] as const)("valida fit DECIMAL(18,2) para %s", (value, valid) => {
  const result = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.price,
          op: "EQ",
          value: { type: "DECIMAL", value },
        },
      ],
    }),
    inspection(),
  );
  expect(result.outcome).toBe(valid ? "RESOLVED" : "INVALID_SEMANTIC_QUERY");
  if (!valid)
    expect(result).toMatchObject({
      issues: [{ code: "DECIMAL_LITERAL_OUT_OF_RANGE" }],
    });
});

test("nao valida range fisico de INTEGER ou NUMBER", () => {
  const result = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.quantity,
          op: "EQ",
          value: { type: "INTEGER", value: "9".repeat(38) },
        },
        {
          fieldKey: ids.score,
          op: "EQ",
          value: { type: "NUMBER", value: "1e999999" },
        },
      ],
    }),
    inspection(),
  );
  expect(result.outcome).toBe("RESOLVED");
});

test("valida temporais somente por correspondencia de SemanticType", () => {
  const result = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.datetime,
          op: "EQ",
          value: { type: "DATE", value: "2026-09-28" },
        },
        {
          fieldKey: ids.instant,
          op: "EQ",
          value: { type: "DATETIME", value: "2026-09-28T12:00:00" },
        },
      ],
    }),
    inspection(),
  );
  expect(result).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [{ code: "INCOMPATIBLE_FILTER" }, { code: "INCOMPATIBLE_FILTER" }],
  });
});

test("valida cada item de IN, preserva ordem e nao deduplica", () => {
  const validValues = [
    { type: "INTEGER", value: "2" },
    { type: "INTEGER", value: "1" },
    { type: "INTEGER", value: "2" },
  ] as const;
  const valid = resolved(
    query({
      filters: [{ fieldKey: ids.quantity, op: "IN", values: validValues }],
    }),
  );
  expect(valid.filters[0]).toMatchObject({ values: validValues });

  const mixed = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.quantity,
          op: "IN",
          values: [
            { type: "INTEGER", value: "1" },
            { type: "STRING", value: "2" },
          ],
        },
      ],
    }),
    inspection(),
  );
  expect(mixed).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [{ path: "$.filters[0].values[1]", code: "INCOMPATIBLE_FILTER" }],
  });
});

test("aceita IS_NULL e IS_NOT_NULL para todos os SemanticTypes", () => {
  const result = resolveSemanticQuery(
    query({
      filters: fieldDefinitions.map(([fieldKey], index) => ({
        fieldKey,
        op: index % 2 ? "IS_NOT_NULL" : "IS_NULL",
      })),
    }),
    inspection(),
  );
  expect(result.outcome).toBe("RESOLVED");
});

test("orderBy aceita somente outputs selecionados e preserva ordem", () => {
  const valid = resolved(
    query({
      metrics: [ids.count, ids.revenue],
      dimensions: [ids.city],
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: ids.revenue },
          direction: "DESC",
        },
        {
          target: { kind: "DIMENSION", fieldKey: ids.city },
          direction: "ASC",
        },
      ],
    }),
  );
  expect(valid.orderBy.map((item) => item.target.kind)).toEqual([
    "METRIC",
    "DIMENSION",
  ]);

  const invalid = resolveSemanticQuery(
    query({
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: ids.count },
          direction: "DESC",
        },
        {
          target: { kind: "DIMENSION", fieldKey: ids.city },
          direction: "ASC",
        },
      ],
    }),
    inspection(),
  );
  expect(invalid).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [
      { path: "$.orderBy[0].target", code: "INVALID_ORDER" },
      { path: "$.orderBy[1].target", code: "INVALID_ORDER" },
    ],
  });
});

test("nao gera erro de order em cascata para key selecionada desconhecida", () => {
  const result = resolveSemanticQuery(
    query({
      metrics: [ids.unknownMetric],
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: ids.unknownMetric },
          direction: "DESC",
        },
      ],
    }),
    inspection(),
  );
  expect(result).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [{ path: "$.metrics[0]", code: "UNKNOWN_METRIC" }],
  });
});

test("nao gera incompatibilidade em cascata para field desconhecido", () => {
  const result = resolveSemanticQuery(
    query({
      filters: [
        {
          fieldKey: ids.unknownField,
          op: "GT",
          value: { type: "STRING", value: "x" },
        },
      ],
    }),
    inspection(),
  );
  expect(result).toMatchObject({
    outcome: "INVALID_SEMANTIC_QUERY",
    issues: [{ path: "$.filters[0].fieldKey", code: "UNKNOWN_FIELD" }],
  });
});

test("preserva limit sem inserir default ou safety cap", () => {
  expect(resolved(query({ limit: 5 })).limit).toBe(5);
  expect(resolved(query())).not.toHaveProperty("limit");
});

test("reconstroi publishedAt sem compartilhar Date nem mutar inspection", () => {
  const snapshot = inspection();
  const inputDate = snapshot.revision.publishedAt;
  if (!inputDate) throw new Error("expected published date");
  const originalTime = inputDate.getTime();
  const output = resolved(query(), snapshot);
  expect(output.revision.publishedAt).not.toBe(inputDate);
  expect(output.revision.publishedAt.getTime()).toBe(originalTime);
  output.revision.publishedAt.setTime(0);
  expect(inputDate.getTime()).toBe(originalTime);
});

test("reconstroi e congela estruturas sem alterar os inputs", () => {
  const snapshot = inspection();
  const semanticQuery = query({ dimensions: [ids.price] });
  const beforeInspection = JSON.stringify(snapshot);
  const beforeQuery = JSON.stringify(semanticQuery);
  const output = resolved(semanticQuery, snapshot);

  expect(JSON.stringify(snapshot)).toBe(beforeInspection);
  expect(JSON.stringify(semanticQuery)).toBe(beforeQuery);
  expect(Object.isFrozen(snapshot)).toBe(false);
  expect(Object.isFrozen(output)).toBe(true);
  expect(Object.isFrozen(output.metrics[0].expression)).toBe(true);
  expect(Object.isFrozen(output.dimensions[0].field.lineage)).toBe(true);
  expect(output.metrics[0].expression).not.toBe(snapshot.metrics[0].expression);
  expect(output.dimensions[0].field).not.toBe(snapshot.fields[3]);
});

test("usa metadata exclusivamente da inspection e ignora extras forçados na query", () => {
  const malicious = {
    ...query(),
    label: "attacker label",
    physicalName: "attacker_column",
    expression: { sql: "DROP TABLE app.metrics" },
    datasetVersionId: ids.unknownField,
    path: "../../secret",
  } as SemanticQueryV1;
  const output = resolved(malicious);
  expect(output.metrics[0]).toMatchObject({
    label: "Total revenue",
    expression: { kind: "aggregate", op: "SUM" },
  });
  expect(JSON.stringify(output)).not.toContain("attacker");
  expect(JSON.stringify(output)).not.toContain("DROP TABLE");
  expect(JSON.stringify(output)).not.toContain("../../secret");
});

test("limita issues a 32 com ordem deterministica e mensagens seguras", () => {
  const badValues = Array.from(
    { length: 50 },
    (_, index) => ({ type: "STRING", value: `secret-${index}` }) as const,
  );
  const semanticQuery = query({
    filters: Array.from({ length: 8 }, () => ({
      fieldKey: ids.quantity,
      op: "IN",
      values: badValues,
    })),
  });
  const first = resolveSemanticQuery(semanticQuery, inspection());
  const second = resolveSemanticQuery(semanticQuery, inspection());
  expect(first).toEqual(second);
  if (first.outcome !== "INVALID_SEMANTIC_QUERY")
    throw new Error("expected invalid query");
  expect(first.issues).toHaveLength(MAX_SEMANTIC_RESOLUTION_ISSUES);
  expect(first.issues[0]).toMatchObject({
    path: "$.filters[0].values[0]",
    code: "INCOMPATIBLE_FILTER",
  });
  expect(first.issues.at(-1)).toMatchObject({
    path: "$",
    code: "ISSUE_LIMIT_REACHED",
  });
  expect(JSON.stringify(first.issues)).not.toContain("secret-");
});
