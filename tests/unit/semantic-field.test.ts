import { expect, test } from "vitest";
import {
  classifyTypeCompatibility,
  validateCreateSemanticFieldInput,
  validateSemanticType,
  validateUpdateSemanticFieldInput,
  type CreateSemanticFieldInput,
  type SemanticType,
} from "../../src/modules/semantic/domain/semantic-field.ts";

const scope = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
};
const valid: CreateSemanticFieldInput = {
  ...scope,
  datasetColumnId: "c0000000-0000-4000-8000-000000000000",
  name: "unit_price",
  label: "Preço unitário",
  description: "Preço de uma unidade",
  semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
  acceptExplicitConversion: true,
};

test.each([
  { kind: "STRING" },
  { kind: "BOOLEAN" },
  { kind: "INTEGER" },
  { kind: "NUMBER" },
  { kind: "DATE" },
  { kind: "DATETIME" },
  { kind: "INSTANT" },
  { kind: "DECIMAL", precision: 1, scale: 0 },
  { kind: "DECIMAL", precision: 38, scale: 38 },
] as SemanticType[])("aceita tipo semântico %#", (semanticType) => {
  expect(() => validateSemanticType(semanticType)).not.toThrow();
});

test.each([
  { kind: "MONEY" },
  { kind: "STRING", precision: 10 },
  { kind: "DECIMAL" },
  { kind: "DECIMAL", precision: 0, scale: 0 },
  { kind: "DECIMAL", precision: 39, scale: 0 },
  { kind: "DECIMAL", precision: 10, scale: -1 },
  { kind: "DECIMAL", precision: 10, scale: 11 },
  { kind: "DECIMAL", precision: 10.5, scale: 2 },
])("rejeita tipo semântico inválido %#", (semanticType) => {
  expect(() => validateSemanticType(semanticType as SemanticType)).toThrow(
    TypeError,
  );
});

test.each([
  ["VARCHAR", { kind: "STRING" }, "SAFE", "DIRECT"],
  ["BOOLEAN", { kind: "BOOLEAN" }, "SAFE", "DIRECT"],
  ["BIGINT", { kind: "INTEGER" }, "SAFE", "DIRECT"],
  ["DOUBLE", { kind: "NUMBER" }, "SAFE", "DIRECT"],
  ["DATE", { kind: "DATE" }, "SAFE", "DIRECT"],
  ["TIMESTAMP", { kind: "DATETIME" }, "SAFE", "DIRECT"],
  ["TIMESTAMP_S", { kind: "DATETIME" }, "SAFE", "DIRECT"],
  ["TIMESTAMP_MS", { kind: "DATETIME" }, "SAFE", "DIRECT"],
  ["TIMESTAMP_NS", { kind: "DATETIME" }, "SAFE", "DIRECT"],
  ["TIMESTAMP WITH TIME ZONE", { kind: "INSTANT" }, "SAFE", "DIRECT"],
  [
    "DECIMAL(18,2)",
    { kind: "DECIMAL", precision: 20, scale: 2 },
    "SAFE",
    "DIRECT",
  ],
  ["DECIMAL(18,0)", { kind: "INTEGER" }, "SAFE", "DIRECT"],
] as const)("%s → %o é %s", (physical, semantic, compatibility, reason) => {
  expect(classifyTypeCompatibility(physical, semantic as SemanticType)).toEqual(
    { compatibility, reason },
  );
});

test.each([
  [
    "BIGINT",
    { kind: "DECIMAL", precision: 19, scale: 0 },
    "EXACT_NUMERIC_CONVERSION",
  ],
  ["INTEGER", { kind: "NUMBER" }, "APPROXIMATE_NUMERIC_CONVERSION"],
  [
    "DOUBLE",
    { kind: "DECIMAL", precision: 18, scale: 2 },
    "ORIGINAL_DECIMAL_NOT_RECOVERABLE",
  ],
  ["DECIMAL(18,2)", { kind: "NUMBER" }, "APPROXIMATE_NUMERIC_CONVERSION"],
  ["UUID", { kind: "STRING" }, "TEXTUAL_UUID"],
] as const)(
  "%s → %o exige intenção explícita",
  (physical, semantic, reason) => {
    expect(
      classifyTypeCompatibility(physical, semantic as SemanticType),
    ).toEqual({ compatibility: "EXPLICIT", reason });
  },
);

test.each([
  ["DATE", { kind: "DATETIME" }],
  ["VARCHAR", { kind: "DATE" }],
  ["BOOLEAN", { kind: "STRING" }],
  ["TIMESTAMP", { kind: "INSTANT" }],
  ["TIMESTAMP WITH TIME ZONE", { kind: "DATETIME" }],
  ["TIME", { kind: "STRING" }],
  ["DECIMAL(18,2)", { kind: "INTEGER" }],
  ["BIGINT", { kind: "DECIMAL", precision: 18, scale: 0 }],
  ["UNKNOWN", { kind: "STRING" }],
] as const)("%s → %o é inválido", (physical, semantic) => {
  expect(
    classifyTypeCompatibility(physical, semantic as SemanticType).compatibility,
  ).toBe("INVALID");
});

test("valida criação e patch sem aceitar campos desconhecidos", () => {
  expect(() => validateCreateSemanticFieldInput(valid)).not.toThrow();
  expect(() =>
    validateCreateSemanticFieldInput({ ...valid, name: "Unit Price" }),
  ).toThrow(TypeError);
  expect(() =>
    validateCreateSemanticFieldInput({ ...valid, label: " label" }),
  ).toThrow(TypeError);
  expect(() =>
    validateCreateSemanticFieldInput({ ...valid, extra: true } as never),
  ).toThrow(TypeError);
  expect(() =>
    validateUpdateSemanticFieldInput({
      ...scope,
      semanticFieldId: "d0000000-0000-4000-8000-000000000000",
      changes: { label: "Novo label" },
    }),
  ).not.toThrow();
  expect(() =>
    validateUpdateSemanticFieldInput({
      ...scope,
      semanticFieldId: "d0000000-0000-4000-8000-000000000000",
      changes: { acceptExplicitConversion: true },
    }),
  ).toThrow(TypeError);
});
