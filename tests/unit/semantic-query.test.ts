import { expect, test } from "vitest";
import {
  MAX_SEMANTIC_QUERY_BYTES,
  MAX_SEMANTIC_QUERY_ISSUES,
  parseSemanticQuery,
  type SemanticLiteral,
} from "../../src/modules/query/domain/semantic-query.ts";

const metric = "A0000000-0000-4000-8000-000000000000";
const field = "B0000000-0000-4000-8000-000000000000";
const otherField = "C0000000-0000-4000-8000-000000000000";

const query = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  metrics: [metric],
  ...extra,
});

const eq = (value: SemanticLiteral) => ({ fieldKey: field, op: "EQ", value });

test("produz contrato canonico, lowercase e imutavel sem metadata dentro da query", () => {
  const input = query({
    dimensions: [field],
    filters: [eq({ type: "STRING", value: "São Paulo" })],
    orderBy: [
      {
        target: { kind: "METRIC", metricKey: metric },
        direction: "DESC",
      },
    ],
    limit: 5,
  });
  const result = parseSemanticQuery(input);
  expect(result).toMatchObject({
    valid: true,
    query: {
      version: 1,
      metrics: [metric.toLowerCase()],
      dimensions: [field.toLowerCase()],
      limit: 5,
    },
  });
  if (!result.valid) throw new Error("expected valid query");
  expect(result.query).not.toBe(input);
  expect(result.query).not.toHaveProperty("canonicalJson");
  expect(result.query).not.toHaveProperty("canonicalBytes");
  expect(result.canonicalBytes).toBe(
    new TextEncoder().encode(result.canonicalJson).byteLength,
  );
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.query)).toBe(true);
  expect(Object.isFrozen(result.query.filters?.[0])).toBe(true);
});

test("omite arrays opcionais vazios e independe da ordem original das propriedades", () => {
  const first = parseSemanticQuery({
    orderBy: [],
    filters: [],
    dimensions: [],
    metrics: [metric],
    version: 1,
  });
  const second = parseSemanticQuery({ version: 1, metrics: [metric] });
  expect(first).toEqual(second);
  if (!first.valid) throw new Error("expected valid query");
  expect(first.query).toEqual({ version: 1, metrics: [metric.toLowerCase()] });
});

test("aceita limites exatos e rejeita contagens fora do contrato", () => {
  const metrics = Array.from(
    { length: 4 },
    (_, index) => `${index}0000000-0000-4000-8000-000000000000`,
  );
  const dimensions = [
    field,
    otherField,
    "d0000000-0000-4000-8000-000000000000",
  ];
  expect(
    parseSemanticQuery(
      query({
        metrics,
        dimensions,
        filters: Array.from({ length: 8 }, () => ({
          fieldKey: field,
          op: "IS_NOT_NULL",
        })),
        orderBy: [
          {
            target: { kind: "METRIC", metricKey: metrics[0] },
            direction: "DESC",
          },
          {
            target: { kind: "DIMENSION", fieldKey: dimensions[0] },
            direction: "ASC",
          },
          {
            target: { kind: "DIMENSION", fieldKey: dimensions[1] },
            direction: "ASC",
          },
        ],
        limit: 1000,
      }),
    ).valid,
  ).toBe(true);
  for (const invalid of [
    query({ metrics: [] }),
    query({ metrics: [...metrics, "e0000000-0000-4000-8000-000000000000"] }),
    query({
      dimensions: [...dimensions, "e0000000-0000-4000-8000-000000000000"],
    }),
    query({
      filters: Array.from({ length: 9 }, () => ({
        fieldKey: field,
        op: "IS_NULL",
      })),
    }),
    query({ limit: 0 }),
    query({ limit: 1001 }),
    query({ limit: 1.5 }),
    query({ limit: "5" }),
  ])
    expect(parseSemanticQuery(invalid).valid).toBe(false);
});

test("rejeita UUIDs invalidos e duplicatas normalizadas", () => {
  for (const invalid of [
    query({ metrics: ["not-a-uuid"] }),
    query({ metrics: [metric, metric.toLowerCase()] }),
    query({ dimensions: [field, field.toLowerCase()] }),
    query({
      orderBy: [
        { target: { kind: "DIMENSION", fieldKey: field }, direction: "ASC" },
        {
          target: { kind: "DIMENSION", fieldKey: field.toLowerCase() },
          direction: "DESC",
        },
      ],
    }),
  ]) {
    const result = parseSemanticQuery(invalid);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.error.issues.some((issue) =>
          ["INVALID_KEY", "DUPLICATE_KEY"].includes(issue.code),
        ),
      ).toBe(true);
  }
});

test("aceita todas as variantes de filtro e aplica AND apenas pela lista", () => {
  const filters = [
    eq({ type: "INTEGER", value: "123" }),
    { fieldKey: field, op: "NEQ", value: { type: "DECIMAL", value: "19.90" } },
    { fieldKey: field, op: "GT", value: { type: "NUMBER", value: "1.5e2" } },
    {
      fieldKey: field,
      op: "GTE",
      value: { type: "DATE", value: "2026-09-28" },
    },
    {
      fieldKey: field,
      op: "LT",
      value: { type: "DATETIME", value: "2026-09-28T12:30:00.123456" },
    },
    {
      fieldKey: field,
      op: "LTE",
      value: { type: "INSTANT", value: "2026-09-28T15:30:00Z" },
    },
    { fieldKey: field, op: "IN", values: [{ type: "BOOLEAN", value: true }] },
    { fieldKey: field, op: "IS_NULL" },
  ];
  expect(parseSemanticQuery(query({ filters })).valid).toBe(true);
  expect(
    parseSemanticQuery(
      query({ filters: [{ fieldKey: field, op: "IS_NOT_NULL" }] }),
    ).valid,
  ).toBe(true);
});

test("aplica exact keys a todos os niveis", () => {
  const cases = [
    { ...query(), sql: "select 1" },
    query({
      filters: [{ ...eq({ type: "STRING", value: "x" }), where: "1=1" }],
    }),
    query({ filters: [eq({ type: "STRING", value: "x", sql: "x" } as never)] }),
    query({
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: metric, name: "x" },
          direction: "ASC",
        },
      ],
    }),
    query({
      orderBy: [
        {
          target: { kind: "METRIC", metricKey: metric },
          direction: "ASC",
          nulls: "FIRST",
        },
      ],
    }),
    query({
      filters: [
        {
          fieldKey: field,
          op: "IS_NULL",
          value: { type: "STRING", value: "x" },
        },
      ],
    }),
  ];
  for (const value of cases) {
    const result = parseSemanticQuery(value);
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(
        result.error.issues.some((issue) => issue.code === "UNKNOWN_PROPERTY"),
      ).toBe(true);
  }
});

test("rejeita prototype pollution, symbols, accessors e prototipos customizados", () => {
  const prototypeKey = JSON.parse(
    `{"version":1,"metrics":["${metric}"],"__proto__":{"polluted":true}}`,
  );
  const symbol = query();
  Object.defineProperty(symbol, Symbol("hidden"), {
    value: true,
    enumerable: true,
  });
  let getterCalled = false;
  const accessor = query();
  Object.defineProperty(accessor, "limit", {
    enumerable: true,
    get() {
      getterCalled = true;
      return 5;
    },
  });
  const custom = Object.assign(Object.create({ inherited: true }), query());

  for (const value of [prototypeKey, symbol, accessor, custom])
    expect(parseSemanticQuery(value).valid).toBe(false);
  expect(getterCalled).toBe(false);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test.each([
  {
    type: "INTEGER",
    valid: ["0", "123", "-42", "9".repeat(38)],
    invalid: ["-0", "+1", "01", "1.0", "1e2", "9".repeat(39)],
  },
  {
    type: "DECIMAL",
    valid: ["0.0", "0.10", "19.90", "-2.50", `0.${"1".repeat(38)}`],
    invalid: ["-0.0", "1", "+1.0", "01.0", "1e2", `1.${"1".repeat(38)}`],
  },
  {
    type: "NUMBER",
    valid: ["0", "1.5", "1.5e2", "-2e-3", "1e999999"],
    invalid: [
      "-0",
      "-0.0e2",
      "+1",
      "01",
      "1E2",
      "1e+2",
      "NaN",
      "Infinity",
      "0x10",
      " 1",
      "1".repeat(65),
    ],
  },
] as const)(
  "valida $type textual sem coerção numerica",
  ({ type, valid, invalid }) => {
    for (const value of valid)
      expect(
        parseSemanticQuery(
          query({ filters: [eq({ type, value } as SemanticLiteral)] }),
        ).valid,
      ).toBe(true);
    for (const value of invalid)
      expect(
        parseSemanticQuery(
          query({ filters: [eq({ type, value } as SemanticLiteral)] }),
        ).valid,
      ).toBe(false);
  },
);

test("NUMBER sintaticamente enorme permanece valido sem conversao para JS number", () => {
  const result = parseSemanticQuery(
    query({ filters: [eq({ type: "NUMBER", value: "1e999999" })] }),
  );
  expect(result).toMatchObject({
    valid: true,
    query: { filters: [{ value: { type: "NUMBER", value: "1e999999" } }] },
  });
});

test("valida STRING por bytes UTF-8, permite vazio e rejeita NUL", () => {
  expect(
    parseSemanticQuery(query({ filters: [eq({ type: "STRING", value: "" })] }))
      .valid,
  ).toBe(true);
  expect(
    parseSemanticQuery(
      query({ filters: [eq({ type: "STRING", value: "á".repeat(2048) })] }),
    ).valid,
  ).toBe(true);
  expect(
    parseSemanticQuery(
      query({ filters: [eq({ type: "STRING", value: "á".repeat(2049) })] }),
    ).valid,
  ).toBe(false);
  expect(
    parseSemanticQuery(
      query({ filters: [eq({ type: "STRING", value: "a\0b" })] }),
    ).valid,
  ).toBe(false);
  expect(
    parseSemanticQuery(
      query({ filters: [eq({ type: "STRING", value: "\ud800" })] }),
    ).valid,
  ).toBe(false);
});

test.each([
  ["DATE", "2024-02-29", true],
  ["DATE", "2026-02-29", false],
  ["DATE", "0000-01-01", false],
  ["DATETIME", "2026-09-28T23:59:59.123456", true],
  ["DATETIME", "2026-09-28 23:59:59", false],
  ["DATETIME", "2026-09-28T24:00:00", false],
  ["DATETIME", "2026-09-28T12:00:00Z", false],
  ["INSTANT", "2026-09-28T12:00:00Z", true],
  ["INSTANT", "2026-09-28T12:00:00.123456Z", true],
  ["INSTANT", "2026-09-28T12:00:00-03:00", false],
  ["INSTANT", "2026-09-28T12:00:00", false],
] as const)("valida temporal %s %s", (type, value, valid) => {
  expect(
    parseSemanticQuery(
      query({ filters: [eq({ type, value } as SemanticLiteral)] }),
    ).valid,
  ).toBe(valid);
});

test("proibe literal NULL e exige operadores proprios", () => {
  expect(
    parseSemanticQuery(
      query({ filters: [{ fieldKey: field, op: "EQ", value: null }] }),
    ).valid,
  ).toBe(false);
  expect(
    parseSemanticQuery(
      query({ filters: [{ fieldKey: field, op: "IS_NULL", value: null }] }),
    ).valid,
  ).toBe(false);
});

test("IN aceita de 1 a 50 literals e rejeita zero ou 51", () => {
  const value = { type: "STRING", value: "x" } as const;
  expect(
    parseSemanticQuery(
      query({ filters: [{ fieldKey: field, op: "IN", values: [value] }] }),
    ).valid,
  ).toBe(true);
  expect(
    parseSemanticQuery(
      query({
        filters: [
          {
            fieldKey: field,
            op: "IN",
            values: Array.from({ length: 50 }, () => value),
          },
        ],
      }),
    ).valid,
  ).toBe(true);
  expect(
    parseSemanticQuery(
      query({ filters: [{ fieldKey: field, op: "IN", values: [] }] }),
    ).valid,
  ).toBe(false);
  expect(
    parseSemanticQuery(
      query({
        filters: [
          {
            fieldKey: field,
            op: "IN",
            values: Array.from({ length: 51 }, () => value),
          },
        ],
      }),
    ).valid,
  ).toBe(false);
});

test("limit ausente permanece ausente e nao recebe safety cap", () => {
  const result = parseSemanticQuery(query());
  expect(result).toMatchObject({ valid: true, query: { version: 1 } });
  if (!result.valid) throw new Error("expected valid query");
  expect(result.query).not.toHaveProperty("limit");
});

test("aceita exatamente 16 KiB canonicos e rejeita um byte adicional", () => {
  const filters = Array.from({ length: 4 }, () =>
    eq({ type: "STRING", value: "" }),
  );
  const empty = parseSemanticQuery(query({ filters }));
  if (!empty.valid) throw new Error("expected base query to be valid");
  const required = MAX_SEMANTIC_QUERY_BYTES - empty.canonicalBytes;
  const lengths = [4096, 4096, 4096, required - 3 * 4096];
  expect(lengths[3]).toBeGreaterThanOrEqual(0);
  expect(lengths[3]).toBeLessThanOrEqual(4096);
  const exact = parseSemanticQuery(
    query({
      filters: lengths.map((length) =>
        eq({ type: "STRING", value: "x".repeat(length) }),
      ),
    }),
  );
  expect(exact).toMatchObject({ valid: true, canonicalBytes: 16 * 1024 });
  lengths[3] += 1;
  const excess = parseSemanticQuery(
    query({
      filters: lengths.map((length) =>
        eq({ type: "STRING", value: "x".repeat(length) }),
      ),
    }),
  );
  expect(excess).toMatchObject({
    valid: false,
    error: { issues: [{ path: "$", code: "QUERY_TOO_LARGE" }] },
  });
});

test("issues sao seguras, deterministicas e limitadas", () => {
  const invalid = query({
    filters: Array.from({ length: 8 }, () => ({
      fieldKey: field,
      op: "IN",
      values: Array.from({ length: 50 }, () => ({ type: "INTEGER", value: 1 })),
    })),
  });
  const first = parseSemanticQuery(invalid);
  const second = parseSemanticQuery(invalid);
  expect(first).toEqual(second);
  if (first.valid) throw new Error("expected invalid query");
  expect(first.error.code).toBe("INVALID_QUERY");
  expect(first.error.issues).toHaveLength(MAX_SEMANTIC_QUERY_ISSUES);
  expect(first.error.issues.at(-1)).toMatchObject({
    path: "$",
    code: "ISSUE_LIMIT_REACHED",
  });
  expect(Object.isFrozen(first.error.issues)).toBe(true);
});

test("rejeita root, versao, operadores e direcoes invalidos", () => {
  for (const value of [
    null,
    [],
    "query",
    { version: 2, metrics: [metric] },
    { version: "1", metrics: [metric] },
    query({
      filters: [
        { fieldKey: field, op: "OR", value: { type: "STRING", value: "x" } },
      ],
    }),
    query({
      orderBy: [
        { target: { kind: "METRIC", metricKey: metric }, direction: "DOWN" },
      ],
    }),
  ])
    expect(parseSemanticQuery(value).valid).toBe(false);
});
