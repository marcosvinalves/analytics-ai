import { describe, expect, test } from "vitest";
import {
  buildGovernedMetricExpression,
  classifyGovernedMetricExpression,
} from "../../src/modules/semantic/domain/governed-metric-template.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const quantity = "10000000-0000-4000-8000-000000000035";
const price = "20000000-0000-4000-8000-000000000035";
const name = "30000000-0000-4000-8000-000000000035";

function fields(
  quantityType: SemanticType = { kind: "INTEGER" },
  priceType: SemanticType = { kind: "DECIMAL", precision: 18, scale: 2 },
) {
  return new Map<string, SemanticType>([
    [quantity, quantityType],
    [price, priceType],
    [name, { kind: "STRING" }],
  ]);
}

describe("governed metric templates", () => {
  test.each([
    ["SUM_FIELD", "SUM"],
    ["COUNT_FIELD", "COUNT"],
    ["COUNT_DISTINCT_FIELD", "COUNT_DISTINCT"],
  ] as const)("constrói AST exato para %s", (template, op) => {
    const result = buildGovernedMetricExpression(
      { template, firstFieldKey: quantity },
      fields(),
    );
    expect(result).toEqual({
      valid: true,
      value: expect.objectContaining({
        expression: {
          version: 1,
          kind: "aggregate",
          op,
          expression: { kind: "field", fieldKey: quantity },
        },
      }),
    });
  });

  test("constrói MULTIPLY determinístico, preserva operandos repetidos e tipos", () => {
    const mixed = buildGovernedMetricExpression(
      {
        template: "SUM_MULTIPLY_FIELDS",
        firstFieldKey: quantity,
        secondFieldKey: price,
      },
      fields(),
    );
    expect(mixed).toMatchObject({
      valid: true,
      value: {
        resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
        expression: {
          op: "SUM",
          expression: {
            kind: "binary",
            op: "MULTIPLY",
            left: { kind: "field", fieldKey: quantity },
            right: { kind: "field", fieldKey: price },
          },
        },
      },
    });
    expect(
      buildGovernedMetricExpression(
        {
          template: "SUM_MULTIPLY_FIELDS",
          firstFieldKey: quantity,
          secondFieldKey: quantity,
        },
        fields(),
      ),
    ).toMatchObject({ valid: true, value: { fieldKeys: [quantity] } });
  });

  test("aplica compatibilidade, NUMBER aproximado e overflow DECIMAL do AST", () => {
    expect(
      buildGovernedMetricExpression(
        { template: "SUM_FIELD", firstFieldKey: name },
        fields(),
      ),
    ).toEqual({ valid: false, reason: "INCOMPATIBLE_FIELDS" });
    expect(
      buildGovernedMetricExpression(
        { template: "SUM_FIELD", firstFieldKey: quantity },
        fields({ kind: "NUMBER" }),
      ),
    ).toMatchObject({ valid: true, value: { resultType: { kind: "NUMBER" } } });
    expect(
      buildGovernedMetricExpression(
        {
          template: "SUM_MULTIPLY_FIELDS",
          firstFieldKey: quantity,
          secondFieldKey: price,
        },
        fields(
          { kind: "DECIMAL", precision: 30, scale: 2 },
          { kind: "DECIMAL", precision: 20, scale: 2 },
        ),
      ),
    ).toEqual({ valid: false, reason: "INCOMPATIBLE_FIELDS" });
  });

  test("classifica somente as quatro formas exatas", () => {
    const supported = buildGovernedMetricExpression(
      {
        template: "SUM_MULTIPLY_FIELDS",
        firstFieldKey: quantity,
        secondFieldKey: price,
      },
      fields(),
    );
    if (!supported.valid) throw new Error("Expected valid template");
    expect(
      classifyGovernedMetricExpression(supported.value.expression),
    ).toEqual({
      kind: "SUPPORTED",
      template: "SUM_MULTIPLY_FIELDS",
      firstFieldKey: quantity,
      secondFieldKey: price,
    });
    expect(
      classifyGovernedMetricExpression({
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: {
          kind: "binary",
          op: "ADD",
          left: { kind: "field", fieldKey: quantity },
          right: { kind: "field", fieldKey: quantity },
        },
      }),
    ).toEqual({ kind: "UNSUPPORTED_TEMPLATE" });
  });
});
