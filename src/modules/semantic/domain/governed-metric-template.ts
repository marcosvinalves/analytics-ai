import type { SemanticType } from "./semantic-field.ts";
import {
  validateMetricExpression,
  type MetricExpression,
  type ValidatedMetricExpression,
} from "./metric-expression.ts";

export const governedMetricTemplates = [
  "SUM_FIELD",
  "COUNT_FIELD",
  "COUNT_DISTINCT_FIELD",
  "SUM_MULTIPLY_FIELDS",
] as const;

export type GovernedMetricTemplate = (typeof governedMetricTemplates)[number];

export type GovernedMetricSelection = {
  template: GovernedMetricTemplate;
  firstFieldKey: string;
  secondFieldKey?: string;
};

export type GovernedMetricClassification =
  | {
      kind: "SUPPORTED";
      template: GovernedMetricTemplate;
      firstFieldKey: string;
      secondFieldKey: string | null;
    }
  | { kind: "UNSUPPORTED_TEMPLATE" };

export type BuildGovernedMetricResult =
  | { valid: true; value: ValidatedMetricExpression }
  | {
      valid: false;
      reason: "INVALID_TEMPLATE" | "UNKNOWN_FIELD" | "INCOMPATIBLE_FIELDS";
    };

export function isGovernedMetricTemplate(
  value: string,
): value is GovernedMetricTemplate {
  return governedMetricTemplates.includes(value as GovernedMetricTemplate);
}

function expressionFor(
  selection: GovernedMetricSelection,
): MetricExpression | null {
  const first = { kind: "field" as const, fieldKey: selection.firstFieldKey };
  if (selection.template === "SUM_MULTIPLY_FIELDS") {
    if (!selection.secondFieldKey) return null;
    return {
      version: 1,
      kind: "aggregate",
      op: "SUM",
      expression: {
        kind: "binary",
        op: "MULTIPLY",
        left: first,
        right: { kind: "field", fieldKey: selection.secondFieldKey },
      },
    };
  }
  if (selection.secondFieldKey) return null;
  return {
    version: 1,
    kind: "aggregate",
    op:
      selection.template === "SUM_FIELD"
        ? "SUM"
        : selection.template === "COUNT_FIELD"
          ? "COUNT"
          : "COUNT_DISTINCT",
    expression: first,
  };
}

export function buildGovernedMetricExpression(
  selection: GovernedMetricSelection,
  fields: ReadonlyMap<string, SemanticType>,
): BuildGovernedMetricResult {
  const expression = expressionFor(selection);
  if (!expression) return { valid: false, reason: "INVALID_TEMPLATE" };
  const validated = validateMetricExpression(expression, fields);
  if (validated.valid) return validated;
  return {
    valid: false,
    reason:
      validated.error.code === "UNKNOWN_FIELD"
        ? "UNKNOWN_FIELD"
        : "INCOMPATIBLE_FIELDS",
  };
}

export function classifyGovernedMetricExpression(
  expression: MetricExpression,
): GovernedMetricClassification {
  const scalar = expression.expression;
  if (scalar.kind === "field") {
    const template =
      expression.op === "SUM"
        ? "SUM_FIELD"
        : expression.op === "COUNT"
          ? "COUNT_FIELD"
          : "COUNT_DISTINCT_FIELD";
    return {
      kind: "SUPPORTED",
      template,
      firstFieldKey: scalar.fieldKey,
      secondFieldKey: null,
    };
  }
  if (
    expression.op === "SUM" &&
    scalar.kind === "binary" &&
    scalar.op === "MULTIPLY" &&
    scalar.left.kind === "field" &&
    scalar.right.kind === "field"
  )
    return {
      kind: "SUPPORTED",
      template: "SUM_MULTIPLY_FIELDS",
      firstFieldKey: scalar.left.fieldKey,
      secondFieldKey: scalar.right.fieldKey,
    };
  return { kind: "UNSUPPORTED_TEMPLATE" };
}
