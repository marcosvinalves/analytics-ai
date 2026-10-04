import {
  validateMetricExpression,
  type MetricExpression,
  type ScalarExpression,
} from "../../semantic/domain/metric-expression.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";
import type { QueryResult, QueryValue } from "./query-result.ts";
import type {
  ResolvedField,
  ResolvedFilter,
  ResolvedMetric,
  ResolvedSemanticQuery,
} from "./resolved-semantic-query.ts";
import type { SemanticLiteral } from "./semantic-query.ts";
import {
  MAX_QUERY_EXPLANATION_ISSUES,
  type BuildQueryExplanationResult,
  type NumericSemantics,
  type QueryExplanation,
  type QueryExplanationField,
  type QueryExplanationFilter,
  type QueryExplanationIssue,
  type QueryExplanationIssueCode,
  type QueryExplanationLiteral,
  type QueryExplanationMetric,
  type QueryExplanationMetricExpression,
  type QueryExplanationOrder,
  type QueryExplanationOutput,
  type QueryExplanationScalarExpression,
} from "./query-explanation.ts";

export type BuildQueryExplanationInput = Readonly<{
  resolvedQuery: ResolvedSemanticQuery;
  result: QueryResult;
}>;

const MESSAGES: Record<QueryExplanationIssueCode, string> = {
  SEMANTIC_MISMATCH: "Os artefatos semanticos sao inconsistentes.",
  RESULT_MISMATCH: "O resultado nao corresponde a consulta semantica.",
  ISSUE_LIMIT_REACHED: "Existem inconsistencias adicionais nao listadas.",
};

class Issues {
  readonly values: QueryExplanationIssue[] = [];
  private full = false;

  add(path: string, code: QueryExplanationIssueCode): void {
    if (this.full) return;
    if (this.values.length === MAX_QUERY_EXPLANATION_ISSUES - 1) {
      this.values.push({
        path: "$",
        code: "ISSUE_LIMIT_REACHED",
        message: MESSAGES.ISSUE_LIMIT_REACHED,
      });
      this.full = true;
      return;
    }
    this.values.push({ path, code, message: MESSAGES[code] });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneType(type: SemanticType): SemanticType {
  return type.kind === "DECIMAL"
    ? { kind: "DECIMAL", precision: type.precision, scale: type.scale }
    : { kind: type.kind };
}

function sameType(left: SemanticType, right: SemanticType): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "DECIMAL" ||
      (right.kind === "DECIMAL" &&
        left.precision === right.precision &&
        left.scale === right.scale))
  );
}

function sameField(left: ResolvedField, right: ResolvedField): boolean {
  return (
    left.fieldKey === right.fieldKey &&
    left.name === right.name &&
    left.label === right.label &&
    sameType(left.semanticType, right.semanticType)
  );
}

function numericSemantics(type: SemanticType): NumericSemantics | undefined {
  if (type.kind === "INTEGER" || type.kind === "DECIMAL") return "EXACT";
  if (type.kind === "NUMBER") return "APPROXIMATE";
  return undefined;
}

function field(value: ResolvedField): QueryExplanationField {
  return {
    fieldKey: value.fieldKey,
    name: value.name,
    label: value.label,
    semanticType: cloneType(value.semanticType),
  };
}

function literal(value: SemanticLiteral): QueryExplanationLiteral {
  return value.type === "BOOLEAN"
    ? { semanticType: "BOOLEAN", value: value.value }
    : { semanticType: value.type, value: value.value };
}

function collectFieldKeys(expression: ScalarExpression, keys: Set<string>) {
  if (expression.kind === "field") {
    keys.add(expression.fieldKey);
    return;
  }
  if (expression.kind === "binary") {
    collectFieldKeys(expression.left, keys);
    collectFieldKeys(expression.right, keys);
  }
}

function scalarExpression(
  expression: ScalarExpression,
  dependencies: ReadonlyMap<string, ResolvedField>,
): QueryExplanationScalarExpression {
  if (expression.kind === "field") {
    const dependency = dependencies.get(expression.fieldKey);
    if (!dependency) throw new Error("SEMANTIC_MISMATCH");
    return {
      kind: "FIELD",
      fieldKey: expression.fieldKey,
      label: dependency.label,
    };
  }
  if (expression.kind === "literal")
    return {
      kind: "LITERAL",
      semanticType: expression.type,
      value: expression.value,
    };
  return {
    kind: "BINARY",
    operator: expression.op,
    left: scalarExpression(expression.left, dependencies),
    right: scalarExpression(expression.right, dependencies),
  };
}

function metricExpression(
  expression: MetricExpression,
  dependencies: ReadonlyMap<string, ResolvedField>,
): QueryExplanationMetricExpression {
  return {
    kind: "AGGREGATE",
    operator: expression.op,
    expression: scalarExpression(expression.expression, dependencies),
  };
}

function validateMetric(
  metric: ResolvedMetric,
  index: number,
  issues: Issues,
): void {
  const path = `$.resolvedQuery.metrics[${index}]`;
  const dependencies = new Map<string, ResolvedField>();
  for (const dependency of metric.dependencies) {
    if (dependencies.has(dependency.fieldKey)) {
      issues.add(`${path}.dependencies`, "SEMANTIC_MISMATCH");
      continue;
    }
    dependencies.set(dependency.fieldKey, dependency);
  }
  const expressionKeys = new Set<string>();
  collectFieldKeys(metric.expression.expression, expressionKeys);
  const declared = [...dependencies.keys()].sort();
  const referenced = [...expressionKeys].sort();
  if (
    declared.length !== referenced.length ||
    declared.some((key, keyIndex) => key !== referenced[keyIndex])
  )
    issues.add(`${path}.dependencies`, "SEMANTIC_MISMATCH");

  const validated = validateMetricExpression(
    metric.expression,
    new Map(
      metric.dependencies.map((dependency) => [
        dependency.fieldKey,
        dependency.semanticType,
      ]),
    ),
  );
  if (
    !validated.valid ||
    !sameType(validated.value.resultType, metric.resultType)
  )
    issues.add(`${path}.expression`, "SEMANTIC_MISMATCH");
}

function validateFilter(
  filter: ResolvedFilter,
  index: number,
  issues: Issues,
): void {
  const path = `$.resolvedQuery.filters[${index}]`;
  if (filter.op === "IS_NULL" || filter.op === "IS_NOT_NULL") return;
  if (
    !["EQ", "NEQ", "IN"].includes(filter.op) &&
    !["INTEGER", "DECIMAL", "NUMBER", "DATE", "DATETIME", "INSTANT"].includes(
      filter.field.semanticType.kind,
    )
  )
    issues.add(`${path}.operator`, "SEMANTIC_MISMATCH");
  if (filter.op !== "IN" && !("value" in filter)) {
    issues.add(path, "SEMANTIC_MISMATCH");
    return;
  }
  const values = filter.op === "IN" ? filter.values : [filter.value];
  values.forEach((value, valueIndex) => {
    const valuePath =
      filter.op === "IN" ? `${path}.values[${valueIndex}]` : `${path}.value`;
    if (value.type !== filter.field.semanticType.kind) {
      issues.add(valuePath, "SEMANTIC_MISMATCH");
      return;
    }
    if (
      value.type === "DECIMAL" &&
      filter.field.semanticType.kind === "DECIMAL"
    ) {
      const [integer, fraction] = value.value.replace("-", "").split(".");
      const integerDigits = integer === "0" ? 0 : integer.length;
      if (
        fraction.length > filter.field.semanticType.scale ||
        integerDigits >
          filter.field.semanticType.precision - filter.field.semanticType.scale
      )
        issues.add(valuePath, "SEMANTIC_MISMATCH");
    }
  });
}

function validateUniqueSelections(
  query: ResolvedSemanticQuery,
  issues: Issues,
): void {
  const metricKeys = new Set<string>();
  query.metrics.forEach((metric, index) => {
    if (metricKeys.has(metric.metricKey))
      issues.add(`$.resolvedQuery.metrics[${index}]`, "SEMANTIC_MISMATCH");
    metricKeys.add(metric.metricKey);
  });
  const fieldKeys = new Set<string>();
  query.dimensions.forEach((dimension, index) => {
    if (fieldKeys.has(dimension.field.fieldKey))
      issues.add(`$.resolvedQuery.dimensions[${index}]`, "SEMANTIC_MISMATCH");
    fieldKeys.add(dimension.field.fieldKey);
  });
}

function validateOrder(query: ResolvedSemanticQuery, issues: Issues): void {
  const metrics = new Map(query.metrics.map((item) => [item.metricKey, item]));
  const dimensions = new Map(
    query.dimensions.map((item) => [item.field.fieldKey, item.field]),
  );
  query.orderBy.forEach((order, index) => {
    const path = `$.resolvedQuery.orderBy[${index}].target`;
    if (order.target.kind === "METRIC") {
      const selected = metrics.get(order.target.metric.metricKey);
      if (
        !selected ||
        selected.name !== order.target.metric.name ||
        selected.label !== order.target.metric.label ||
        !sameType(selected.resultType, order.target.metric.resultType)
      )
        issues.add(path, "SEMANTIC_MISMATCH");
      return;
    }
    const selected = dimensions.get(order.target.dimension.field.fieldKey);
    if (!selected || !sameField(selected, order.target.dimension.field))
      issues.add(path, "SEMANTIC_MISMATCH");
  });
}

function expectedOutputs(
  query: ResolvedSemanticQuery,
): QueryExplanationOutput[] {
  return [
    ...query.dimensions.map(({ field: value }) => {
      const semantics = numericSemantics(value.semanticType);
      return {
        key: value.fieldKey,
        label: value.label,
        role: "DIMENSION" as const,
        semanticType: cloneType(value.semanticType),
        ...(semantics ? { numericSemantics: semantics } : {}),
      };
    }),
    ...query.metrics.map((value) => {
      const semantics = numericSemantics(value.resultType);
      return {
        key: value.metricKey,
        label: value.label,
        role: "METRIC" as const,
        semanticType: cloneType(value.resultType),
        ...(semantics ? { numericSemantics: semantics } : {}),
      };
    }),
  ];
}

function valueMatches(value: QueryValue, type: SemanticType): boolean {
  return value.type === "NULL" || value.type === type.kind;
}

function validateResult(
  result: QueryResult,
  outputs: readonly QueryExplanationOutput[],
  issues: Issues,
): void {
  if (result.columns.length !== outputs.length)
    issues.add("$.result.columns", "RESULT_MISMATCH");
  const count = Math.min(result.columns.length, outputs.length);
  for (let index = 0; index < count; index += 1) {
    const actual = result.columns[index];
    const expected = outputs[index];
    if (
      actual.key !== expected.key ||
      actual.label !== expected.label ||
      actual.role !== expected.role ||
      !sameType(actual.semanticType, expected.semanticType)
    )
      issues.add(`$.result.columns[${index}]`, "RESULT_MISMATCH");
  }
  result.rows.forEach((row, rowIndex) => {
    if (row.length !== outputs.length) {
      issues.add(`$.result.rows[${rowIndex}]`, "RESULT_MISMATCH");
      return;
    }
    row.forEach((value, columnIndex) => {
      if (!valueMatches(value, outputs[columnIndex].semanticType))
        issues.add(
          `$.result.rows[${rowIndex}][${columnIndex}]`,
          "RESULT_MISMATCH",
        );
    });
  });
}

function explanationMetric(metric: ResolvedMetric): QueryExplanationMetric {
  const dependencies = new Map(
    metric.dependencies.map((dependency) => [dependency.fieldKey, dependency]),
  );
  const semantics = numericSemantics(metric.resultType);
  if (!semantics) throw new Error("SEMANTIC_MISMATCH");
  return {
    metricKey: metric.metricKey,
    name: metric.name,
    label: metric.label,
    resultType: cloneType(metric.resultType),
    numericSemantics: semantics,
    expression: metricExpression(metric.expression, dependencies),
    dependencies: metric.dependencies.map(field),
  };
}

function explanationFilter(filter: ResolvedFilter): QueryExplanationFilter {
  if (filter.op === "IS_NULL" || filter.op === "IS_NOT_NULL")
    return { field: field(filter.field), operator: filter.op };
  if (filter.op === "IN")
    return {
      field: field(filter.field),
      operator: "IN",
      values: filter.values.map(literal),
    };
  if (!("value" in filter)) throw new Error("SEMANTIC_MISMATCH");
  return {
    field: field(filter.field),
    operator: filter.op,
    value: literal(filter.value),
  };
}

function explanationOrder(
  order: ResolvedSemanticQuery["orderBy"][number],
): QueryExplanationOrder {
  return order.target.kind === "METRIC"
    ? {
        target: {
          role: "METRIC",
          key: order.target.metric.metricKey,
          label: order.target.metric.label,
        },
        direction: order.direction,
        nulls: "LAST",
      }
    : {
        target: {
          role: "DIMENSION",
          key: order.target.dimension.field.fieldKey,
          label: order.target.dimension.field.label,
        },
        direction: order.direction,
        nulls: "LAST",
      };
}

function failure(issues: Issues): BuildQueryExplanationResult {
  return deepFreeze({
    outcome: "INCONSISTENT_QUERY_ARTIFACTS",
    issues: [...issues.values],
  });
}

export function buildQueryExplanation(
  input: BuildQueryExplanationInput,
): BuildQueryExplanationResult {
  const issues = new Issues();
  try {
    validateUniqueSelections(input.resolvedQuery, issues);
    input.resolvedQuery.metrics.forEach((metric, index) =>
      validateMetric(metric, index, issues),
    );
    input.resolvedQuery.filters.forEach((filter, index) =>
      validateFilter(filter, index, issues),
    );
    validateOrder(input.resolvedQuery, issues);
    if (
      !(input.resolvedQuery.revision.publishedAt instanceof Date) ||
      !Number.isFinite(input.resolvedQuery.revision.publishedAt.getTime())
    )
      issues.add("$.resolvedQuery.revision.publishedAt", "SEMANTIC_MISMATCH");
    const outputs = expectedOutputs(input.resolvedQuery);
    validateResult(input.result, outputs, issues);
    if (issues.values.length) return failure(issues);

    const explanation: QueryExplanation = {
      version: 1,
      model: { ...input.resolvedQuery.model },
      revision: {
        id: input.resolvedQuery.revision.id,
        revisionNumber: input.resolvedQuery.revision.revisionNumber,
        label: input.resolvedQuery.revision.label,
        publishedAt: input.resolvedQuery.revision.publishedAt.toISOString(),
      },
      dataset: { ...input.resolvedQuery.dataset },
      datasetVersion: { ...input.resolvedQuery.datasetVersion },
      metrics: input.resolvedQuery.metrics.map(explanationMetric),
      dimensions: input.resolvedQuery.dimensions.map(({ field: value }) =>
        field(value),
      ),
      filters: {
        combination: "AND",
        items: input.resolvedQuery.filters.map(explanationFilter),
      },
      orderBy: input.resolvedQuery.orderBy.map(explanationOrder),
      ...(input.resolvedQuery.limit === undefined
        ? {}
        : { semanticLimit: input.resolvedQuery.limit }),
      outputs,
      resultShape: {
        rowCount: input.result.rows.length,
        columnCount: input.result.columns.length,
      },
    };
    return deepFreeze({ outcome: "EXPLAINED", explanation });
  } catch {
    if (!issues.values.length) issues.add("$", "SEMANTIC_MISMATCH");
    return failure(issues);
  }
}
