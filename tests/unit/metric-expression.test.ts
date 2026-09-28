import { expect, test } from "vitest";
import {
  MAX_AST_DEPTH,
  MAX_AST_NODES,
  MAX_EXPRESSION_BYTES,
  validateMetricExpression,
  type ScalarExpression,
} from "../../src/modules/semantic/domain/metric-expression.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const quantity = "a0000000-0000-4000-8000-000000000000";
const price = "b0000000-0000-4000-8000-000000000000";
const category = "c0000000-0000-4000-8000-000000000000";
const fields = new Map<string, SemanticType>([
  [quantity, { kind: "INTEGER" }],
  [price, { kind: "DECIMAL", precision: 18, scale: 2 }],
  [category, { kind: "STRING" }],
]);

const aggregate = (
  op: "SUM" | "COUNT" | "COUNT_DISTINCT",
  expression: unknown,
) => ({
  version: 1,
  kind: "aggregate",
  op,
  expression,
});
const field = (fieldKey: string): ScalarExpression => ({
  kind: "field",
  fieldKey,
});

test("infere o caso central INTEGER × DECIMAL sem perder scale", () => {
  const result = validateMetricExpression(
    aggregate("SUM", {
      kind: "binary",
      op: "MULTIPLY",
      left: field(quantity),
      right: field(price),
    }),
    fields,
  );
  expect(result).toMatchObject({
    valid: true,
    value: {
      resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
      fieldKeys: [quantity, price],
    },
  });
});

test.each(["ADD", "SUBTRACT", "MULTIPLY"] as const)(
  "INTEGER %s DECIMAL promove para DECIMAL(38,s)",
  (op) => {
    const result = validateMetricExpression(
      aggregate("SUM", {
        kind: "binary",
        op,
        left: field(price),
        right: field(quantity),
      }),
      fields,
    );
    expect(result).toMatchObject({
      valid: true,
      value: { resultType: { kind: "DECIMAL", precision: 38, scale: 2 } },
    });
  },
);

test("literal INTEGER usa quantidade conhecida de dígitos com DECIMAL", () => {
  const result = validateMetricExpression(
    aggregate("SUM", {
      kind: "binary",
      op: "MULTIPLY",
      left: { kind: "literal", type: "INTEGER", value: "12" },
      right: { kind: "literal", type: "DECIMAL", value: "0.15" },
    }),
    fields,
  );
  expect(result).toMatchObject({
    valid: true,
    value: { resultType: { kind: "DECIMAL", precision: 38, scale: 2 } },
  });
});

test("largura conhecida do literal detecta overflow DECIMAL estaticamente", () => {
  const localFields = new Map<string, SemanticType>([
    [price, { kind: "DECIMAL", precision: 37, scale: 2 }],
  ]);
  expect(
    validateMetricExpression(
      aggregate("SUM", {
        kind: "binary",
        op: "MULTIPLY",
        left: { kind: "literal", type: "INTEGER", value: "12" },
        right: field(price),
      }),
      localFields,
    ),
  ).toMatchObject({
    valid: false,
    error: { code: "DECIMAL_PRECISION_OVERFLOW" },
  });
});

test.each([
  ["ADD", 2],
  ["SUBTRACT", 2],
  ["MULTIPLY", 4],
] as const)("DECIMAL %s DECIMAL preserva scale %i no SUM", (op, scale) => {
  const localFields = new Map<string, SemanticType>([
    [quantity, { kind: "DECIMAL", precision: 10, scale: 2 }],
    [price, { kind: "DECIMAL", precision: 10, scale: 2 }],
  ]);
  const binary = {
    kind: "binary",
    op,
    left: field(quantity),
    right: field(price),
  };
  const result = validateMetricExpression(
    aggregate("SUM", binary),
    localFields,
  );
  expect(result).toMatchObject({
    valid: true,
    value: {
      resultType: {
        kind: "DECIMAL",
        precision: 38,
        scale,
      },
    },
  });
});

test("rejeita overflow DECIMAL antes da agregação", () => {
  const localFields = new Map<string, SemanticType>([
    [quantity, { kind: "DECIMAL", precision: 30, scale: 10 }],
    [price, { kind: "DECIMAL", precision: 20, scale: 5 }],
  ]);
  expect(
    validateMetricExpression(
      aggregate("SUM", {
        kind: "binary",
        op: "MULTIPLY",
        left: field(quantity),
        right: field(price),
      }),
      localFields,
    ),
  ).toEqual({
    valid: false,
    error: { code: "DECIMAL_PRECISION_OVERFLOW", path: "$.expression" },
  });
});

test("NUMBER combinado com tipo exato resulta NUMBER", () => {
  const localFields = new Map(fields).set(category, { kind: "NUMBER" });
  expect(
    validateMetricExpression(
      aggregate("SUM", {
        kind: "binary",
        op: "ADD",
        left: field(category),
        right: field(price),
      }),
      localFields,
    ),
  ).toMatchObject({ valid: true, value: { resultType: { kind: "NUMBER" } } });
});

test("COUNT e COUNT_DISTINCT aceitam qualquer tipo e retornam INTEGER", () => {
  for (const op of ["COUNT", "COUNT_DISTINCT"] as const)
    expect(
      validateMetricExpression(aggregate(op, field(category)), fields),
    ).toMatchObject({
      valid: true,
      value: { resultType: { kind: "INTEGER" } },
    });
});

test("SUM rejeita tipo não numérico", () => {
  expect(
    validateMetricExpression(aggregate("SUM", field(category)), fields),
  ).toEqual({
    valid: false,
    error: { code: "INCOMPATIBLE_TYPE", path: "$.expression" },
  });
});

test.each([
  ["INTEGER", "0"],
  ["INTEGER", "-12"],
  ["DECIMAL", "0.10"],
  ["DECIMAL", "-12.30"],
] as const)("aceita literal %s canônico %s", (type, value) => {
  expect(
    validateMetricExpression(
      aggregate("SUM", { kind: "literal", type, value }),
      fields,
    ).valid,
  ).toBe(true);
});

test.each([
  ["INTEGER", "01"],
  ["INTEGER", "+1"],
  ["INTEGER", "-0"],
  ["INTEGER", "1.0"],
  ["DECIMAL", "1"],
  ["DECIMAL", "01.20"],
  ["DECIMAL", "1e-2"],
  ["DECIMAL", "-0.00"],
] as const)("rejeita literal %s não canônico %s", (type, value) => {
  expect(
    validateMetricExpression(
      aggregate("SUM", { kind: "literal", type, value }),
      fields,
    ),
  ).toMatchObject({ valid: false, error: { code: "INVALID_LITERAL" } });
});

test("canonicaliza key order e deduplica field references", () => {
  const result = validateMetricExpression(
    {
      expression: {
        right: field(quantity),
        left: field(quantity),
        op: "ADD",
        kind: "binary",
      },
      op: "SUM",
      kind: "aggregate",
      version: 1,
    },
    fields,
  );
  if (!result.valid) throw new Error("Expected valid expression");
  expect(result.value.fieldKeys).toEqual([quantity]);
  expect(result.value.canonicalJson).toBe(
    JSON.stringify(result.value.expression),
  );
  expect(result.value.canonicalBytes).toBe(
    new TextEncoder().encode(result.value.canonicalJson).byteLength,
  );
  expect(result.value.canonicalBytes).toBeLessThan(MAX_EXPRESSION_BYTES);
});

test("rejeita raiz não agregada, aggregate aninhado, field desconhecido e extras", () => {
  expect(validateMetricExpression(field(quantity), fields)).toMatchObject({
    valid: false,
    error: { code: "ROOT_AGGREGATE_REQUIRED" },
  });
  expect(
    validateMetricExpression(
      aggregate("SUM", aggregate("COUNT", field(quantity))),
      fields,
    ),
  ).toMatchObject({ valid: false, error: { code: "NESTED_AGGREGATE" } });
  expect(
    validateMetricExpression(
      aggregate("COUNT", field("d0000000-0000-4000-8000-000000000000")),
      fields,
    ),
  ).toMatchObject({ valid: false, error: { code: "UNKNOWN_FIELD" } });
  expect(
    validateMetricExpression(
      { ...aggregate("COUNT", field(quantity)), sql: "COUNT(*)" },
      fields,
    ),
  ).toMatchObject({ valid: false, error: { code: "MALFORMED_AST" } });
});

test("rejeita profundidade maior que o limite", () => {
  let expression: ScalarExpression = field(quantity);
  for (let index = 0; index < MAX_AST_DEPTH; index += 1)
    expression = {
      kind: "binary",
      op: "ADD",
      left: expression,
      right: { kind: "literal", type: "INTEGER", value: "1" },
    };
  expect(
    validateMetricExpression(aggregate("SUM", expression), fields),
  ).toMatchObject({
    valid: false,
    error: { code: "AST_LIMIT_EXCEEDED" },
  });
});

test("rejeita mais nós que o limite", () => {
  let level: ScalarExpression[] = Array.from({ length: 33 }, () =>
    field(quantity),
  );
  while (level.length > 1) {
    const next: ScalarExpression[] = [];
    for (let index = 0; index < level.length; index += 2)
      next.push(
        level[index + 1]
          ? {
              kind: "binary",
              op: "ADD",
              left: level[index],
              right: level[index + 1],
            }
          : level[index],
      );
    level = next;
  }
  expect(MAX_AST_NODES).toBe(64);
  expect(
    validateMetricExpression(aggregate("SUM", level[0]), fields),
  ).toMatchObject({
    valid: false,
    error: { code: "AST_LIMIT_EXCEEDED" },
  });
});
