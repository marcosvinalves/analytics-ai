import type { SemanticType } from "./semantic-field.ts";

export const MAX_AST_DEPTH = 8;
export const MAX_AST_NODES = 64;
export const MAX_EXPRESSION_BYTES = 16 * 1024;

export type FieldExpression = { kind: "field"; fieldKey: string };
export type LiteralExpression = {
  kind: "literal";
  type: "INTEGER" | "DECIMAL";
  value: string;
};
export type BinaryExpression = {
  kind: "binary";
  op: "ADD" | "SUBTRACT" | "MULTIPLY";
  left: ScalarExpression;
  right: ScalarExpression;
};
export type ScalarExpression =
  FieldExpression | LiteralExpression | BinaryExpression;
export type MetricExpression = {
  version: 1;
  kind: "aggregate";
  op: "SUM" | "COUNT" | "COUNT_DISTINCT";
  expression: ScalarExpression;
};

export type InvalidExpressionCode =
  | "MALFORMED_AST"
  | "ROOT_AGGREGATE_REQUIRED"
  | "NESTED_AGGREGATE"
  | "AST_LIMIT_EXCEEDED"
  | "INVALID_LITERAL"
  | "UNKNOWN_FIELD"
  | "INCOMPATIBLE_TYPE"
  | "DECIMAL_PRECISION_OVERFLOW";

export type InvalidExpression = {
  code: InvalidExpressionCode;
  path: string;
};

export type ValidatedMetricExpression = {
  expression: MetricExpression;
  resultType: SemanticType;
  fieldKeys: string[];
  canonicalJson: string;
  canonicalBytes: number;
};

export type MetricExpressionValidationResult =
  | { valid: true; value: ValidatedMetricExpression }
  | { valid: false; error: InvalidExpression };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const INTEGER_LITERAL = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL_LITERAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
const NUMERIC_TYPES = new Set(["INTEGER", "DECIMAL", "NUMBER"]);

type ParseState = { nodes: number };
type ParseResult<T> = { value: T } | { error: InvalidExpression };
export type InferredScalarType = {
  type: SemanticType;
  integerDigits?: number;
};

export type InferScalarExpressionTypeResult =
  | { valid: true; value: InferredScalarType }
  | { valid: false; error: InvalidExpression };

function failure(code: InvalidExpressionCode, path: string): InvalidExpression {
  return { code, path };
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function enterNode(
  state: ParseState,
  depth: number,
  path: string,
): InvalidExpression | undefined {
  state.nodes += 1;
  if (depth > MAX_AST_DEPTH || state.nodes > MAX_AST_NODES)
    return failure("AST_LIMIT_EXCEEDED", path);
  return undefined;
}

function parseScalar(
  input: unknown,
  state: ParseState,
  depth: number,
  path: string,
): ParseResult<ScalarExpression> {
  const limit = enterNode(state, depth, path);
  if (limit) return { error: limit };
  if (!isObject(input) || typeof input.kind !== "string")
    return { error: failure("MALFORMED_AST", path) };
  if (input.kind === "aggregate")
    return { error: failure("NESTED_AGGREGATE", path) };
  if (input.kind === "field") {
    if (
      !hasExactKeys(input, ["kind", "fieldKey"]) ||
      typeof input.fieldKey !== "string" ||
      !UUID.test(input.fieldKey)
    )
      return { error: failure("MALFORMED_AST", path) };
    return { value: { kind: "field", fieldKey: input.fieldKey } };
  }
  if (input.kind === "literal") {
    if (
      !hasExactKeys(input, ["kind", "type", "value"]) ||
      (input.type !== "INTEGER" && input.type !== "DECIMAL") ||
      typeof input.value !== "string"
    )
      return { error: failure("MALFORMED_AST", path) };
    if (!validLiteral(input.type, input.value))
      return { error: failure("INVALID_LITERAL", `${path}.value`) };
    return {
      value: { kind: "literal", type: input.type, value: input.value },
    };
  }
  if (input.kind === "binary") {
    if (
      !hasExactKeys(input, ["kind", "op", "left", "right"]) ||
      !["ADD", "SUBTRACT", "MULTIPLY"].includes(String(input.op))
    )
      return { error: failure("MALFORMED_AST", path) };
    const left = parseScalar(input.left, state, depth + 1, `${path}.left`);
    if ("error" in left) return left;
    const right = parseScalar(input.right, state, depth + 1, `${path}.right`);
    if ("error" in right) return right;
    return {
      value: {
        kind: "binary",
        op: input.op as BinaryExpression["op"],
        left: left.value,
        right: right.value,
      },
    };
  }
  return { error: failure("MALFORMED_AST", path) };
}

function validLiteral(type: "INTEGER" | "DECIMAL", value: string): boolean {
  if (type === "INTEGER") {
    if (!INTEGER_LITERAL.test(value) || value === "-0") return false;
    return value.replace("-", "").length <= 38;
  }
  if (!DECIMAL_LITERAL.test(value) || /^-0\.0+$/.test(value)) return false;
  const unsigned = value.replace("-", "");
  const [integer, fraction] = unsigned.split(".");
  const precision = (integer === "0" ? 0 : integer.length) + fraction.length;
  return Math.max(1, precision) <= 38;
}

function literalType(literal: LiteralExpression): InferredScalarType {
  const unsigned = literal.value.replace("-", "");
  if (literal.type === "INTEGER")
    return { type: { kind: "INTEGER" }, integerDigits: unsigned.length };
  const [integer, fraction] = unsigned.split(".");
  return {
    type: {
      kind: "DECIMAL",
      precision: Math.max(
        1,
        (integer === "0" ? 0 : integer.length) + fraction.length,
      ),
      scale: fraction.length,
    },
  };
}

function decimalBinary(
  op: BinaryExpression["op"],
  left: Extract<SemanticType, { kind: "DECIMAL" }>,
  right: Extract<SemanticType, { kind: "DECIMAL" }>,
  path: string,
): ParseResult<InferredScalarType> {
  const scale =
    op === "MULTIPLY"
      ? left.scale + right.scale
      : Math.max(left.scale, right.scale);
  const precision =
    op === "MULTIPLY"
      ? left.precision + right.precision
      : Math.max(left.precision - left.scale, right.precision - right.scale) +
        scale +
        1;
  if (precision > 38 || scale > 38)
    return { error: failure("DECIMAL_PRECISION_OVERFLOW", path) };
  return { value: { type: { kind: "DECIMAL", precision, scale } } };
}

function integerDecimal(
  op: BinaryExpression["op"],
  integer: InferredScalarType,
  decimal: Extract<SemanticType, { kind: "DECIMAL" }>,
  path: string,
): ParseResult<InferredScalarType> {
  if (integer.integerDigits === undefined)
    return {
      value: {
        type: { kind: "DECIMAL", precision: 38, scale: decimal.scale },
      },
    };
  const asDecimal: Extract<SemanticType, { kind: "DECIMAL" }> = {
    kind: "DECIMAL",
    precision: integer.integerDigits,
    scale: 0,
  };
  return decimalBinary(op, asDecimal, decimal, path);
}

function inferBinary(
  op: BinaryExpression["op"],
  left: InferredScalarType,
  right: InferredScalarType,
  path: string,
): ParseResult<InferredScalarType> {
  if (!NUMERIC_TYPES.has(left.type.kind) || !NUMERIC_TYPES.has(right.type.kind))
    return { error: failure("INCOMPATIBLE_TYPE", path) };
  if (left.type.kind === "NUMBER" || right.type.kind === "NUMBER")
    return { value: { type: { kind: "NUMBER" } } };
  if (left.type.kind === "INTEGER" && right.type.kind === "INTEGER")
    return { value: { type: { kind: "INTEGER" } } };
  if (left.type.kind === "DECIMAL" && right.type.kind === "DECIMAL")
    return decimalBinary(op, left.type, right.type, path);
  if (left.type.kind === "INTEGER" && right.type.kind === "DECIMAL")
    return integerDecimal(op, left, right.type, path);
  if (left.type.kind === "DECIMAL" && right.type.kind === "INTEGER")
    return integerDecimal(op, right, left.type, path);
  return { error: failure("INCOMPATIBLE_TYPE", path) };
}

function inferScalar(
  expression: ScalarExpression,
  fields: ReadonlyMap<string, SemanticType>,
  path: string,
  fieldKeys: Set<string>,
): ParseResult<InferredScalarType> {
  if (expression.kind === "field") {
    const type = fields.get(expression.fieldKey);
    if (!type) return { error: failure("UNKNOWN_FIELD", path) };
    fieldKeys.add(expression.fieldKey);
    return { value: { type } };
  }
  if (expression.kind === "literal") return { value: literalType(expression) };
  const left = inferScalar(expression.left, fields, `${path}.left`, fieldKeys);
  if ("error" in left) return left;
  const right = inferScalar(
    expression.right,
    fields,
    `${path}.right`,
    fieldKeys,
  );
  if ("error" in right) return right;
  return inferBinary(expression.op, left.value, right.value, path);
}

/** Reuses the T-012 inference rules for an already-normalized scalar subtree. */
export function inferScalarExpressionType(
  expression: ScalarExpression,
  fields: ReadonlyMap<string, SemanticType>,
): InferScalarExpressionTypeResult {
  const inferred = inferScalar(expression, fields, "$", new Set<string>());
  return "error" in inferred
    ? { valid: false, error: inferred.error }
    : { valid: true, value: inferred.value };
}

export function validateMetricExpression(
  input: unknown,
  fields: ReadonlyMap<string, SemanticType>,
): MetricExpressionValidationResult {
  if (!isObject(input) || input.kind !== "aggregate")
    return {
      valid: false,
      error: failure("ROOT_AGGREGATE_REQUIRED", "$"),
    };
  if (
    !hasExactKeys(input, ["version", "kind", "op", "expression"]) ||
    input.version !== 1 ||
    !["SUM", "COUNT", "COUNT_DISTINCT"].includes(String(input.op))
  )
    return { valid: false, error: failure("MALFORMED_AST", "$") };
  const state = { nodes: 1 };
  const scalar = parseScalar(input.expression, state, 2, "$.expression");
  if ("error" in scalar) return { valid: false, error: scalar.error };
  const expression: MetricExpression = {
    version: 1,
    kind: "aggregate",
    op: input.op as MetricExpression["op"],
    expression: scalar.value,
  };
  const canonicalJson = JSON.stringify(expression);
  const canonicalBytes = new TextEncoder().encode(canonicalJson).byteLength;
  if (canonicalBytes > MAX_EXPRESSION_BYTES)
    return {
      valid: false,
      error: failure("AST_LIMIT_EXCEEDED", "$"),
    };
  const fieldKeys = new Set<string>();
  const inferred = inferScalar(
    expression.expression,
    fields,
    "$.expression",
    fieldKeys,
  );
  if ("error" in inferred) return { valid: false, error: inferred.error };
  let resultType: SemanticType;
  if (expression.op === "SUM") {
    if (
      inferred.value.type.kind !== "INTEGER" &&
      inferred.value.type.kind !== "DECIMAL" &&
      inferred.value.type.kind !== "NUMBER"
    )
      return {
        valid: false,
        error: failure("INCOMPATIBLE_TYPE", "$.expression"),
      };
    resultType =
      inferred.value.type.kind === "DECIMAL"
        ? {
            kind: "DECIMAL",
            precision: 38,
            scale: inferred.value.type.scale,
          }
        : inferred.value.type;
  } else {
    // Cardinality is non-negative semantic INTEGER; it is not a physical field representation.
    resultType = { kind: "INTEGER" };
  }
  return {
    valid: true,
    value: {
      expression,
      resultType,
      fieldKeys: [...fieldKeys].sort(),
      canonicalJson,
      canonicalBytes,
    },
  };
}
