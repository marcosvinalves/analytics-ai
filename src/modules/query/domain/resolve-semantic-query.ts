import type {
  MetricInspection,
  SemanticFieldInspection,
  SemanticModelInspection,
} from "../../semantic/domain/semantic-inspection.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";
import type {
  MetricExpression,
  ScalarExpression,
} from "../../semantic/domain/metric-expression.ts";
import type {
  SemanticFilter,
  SemanticLiteral,
  SemanticQueryV1,
} from "./semantic-query.ts";
import {
  MAX_SEMANTIC_RESOLUTION_ISSUES,
  type ResolveSemanticQueryResult,
  type ResolvedDimension,
  type ResolvedField,
  type ResolvedFilter,
  type ResolvedMetric,
  type ResolvedOrder,
  type SemanticResolutionIssue,
  type SemanticResolutionIssueCode,
} from "./resolved-semantic-query.ts";

function cloneSemanticType(type: SemanticType): SemanticType {
  return type.kind === "DECIMAL"
    ? { kind: "DECIMAL", precision: type.precision, scale: type.scale }
    : { kind: type.kind };
}

function cloneScalarExpression(expression: ScalarExpression): ScalarExpression {
  if (expression.kind === "field")
    return { kind: "field", fieldKey: expression.fieldKey };
  if (expression.kind === "literal")
    return {
      kind: "literal",
      type: expression.type,
      value: expression.value,
    };
  return {
    kind: "binary",
    op: expression.op,
    left: cloneScalarExpression(expression.left),
    right: cloneScalarExpression(expression.right),
  };
}

function cloneMetricExpression(expression: MetricExpression): MetricExpression {
  return {
    version: 1,
    kind: "aggregate",
    op: expression.op,
    expression: cloneScalarExpression(expression.expression),
  };
}

function cloneSemanticLiteral(literal: SemanticLiteral): SemanticLiteral {
  return literal.type === "BOOLEAN"
    ? { type: "BOOLEAN", value: literal.value }
    : { type: literal.type, value: literal.value };
}

function deepFreezeResolved<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeResolved(child);
    Object.freeze(value);
  }
  return value;
}

const ORDERED_TYPES = new Set<SemanticType["kind"]>([
  "INTEGER",
  "DECIMAL",
  "NUMBER",
  "DATE",
  "DATETIME",
  "INSTANT",
]);

const MESSAGES: Record<SemanticResolutionIssueCode, string> = {
  UNKNOWN_METRIC: "A metrica solicitada nao existe no snapshot semantico.",
  UNKNOWN_FIELD: "O campo solicitado nao existe no snapshot semantico.",
  INCOMPATIBLE_FILTER: "O filtro nao e compativel com o campo semantico.",
  DECIMAL_LITERAL_OUT_OF_RANGE:
    "O literal decimal nao cabe na precision e scale do campo.",
  INVALID_ORDER: "A ordenacao deve referenciar uma coluna selecionada.",
  ISSUE_LIMIT_REACHED: "A consulta possui erros adicionais nao listados.",
};

class Issues {
  readonly values: SemanticResolutionIssue[] = [];
  private full = false;

  add(path: string, code: SemanticResolutionIssueCode): void {
    if (this.full) return;
    if (this.values.length === MAX_SEMANTIC_RESOLUTION_ISSUES - 1) {
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

function resolvedField(field: SemanticFieldInspection): ResolvedField {
  return deepFreezeResolved({
    fieldKey: field.fieldKey,
    name: field.name,
    label: field.label,
    semanticType: cloneSemanticType(field.semanticType),
    lineage: {
      physicalName: field.lineage.physicalName,
      physicalType: field.lineage.physicalType,
      ordinalPosition: field.lineage.ordinalPosition,
    },
  });
}

function resolvedMetric(
  metric: MetricInspection,
  fields: ReadonlyMap<string, ResolvedField>,
): ResolvedMetric {
  return deepFreezeResolved({
    metricKey: metric.metricKey,
    name: metric.name,
    label: metric.label,
    expression: cloneMetricExpression(metric.expression),
    resultType: cloneSemanticType(metric.resultType),
    dependencies: metric.dependencies.map((fieldKey) => {
      const field = fields.get(fieldKey);
      if (!field) throw new Error("SEMANTIC_INSPECTION_INCONSISTENT");
      return field;
    }),
  });
}

function decimalFits(
  value: string,
  type: Extract<SemanticType, { kind: "DECIMAL" }>,
): boolean {
  const [integer, fraction] = value.replace("-", "").split(".");
  const integerDigits = integer === "0" ? 0 : integer.length;
  return (
    fraction.length <= type.scale &&
    integerDigits <= type.precision - type.scale
  );
}

function literalIssue(
  literal: SemanticLiteral,
  type: SemanticType,
): "INCOMPATIBLE_FILTER" | "DECIMAL_LITERAL_OUT_OF_RANGE" | undefined {
  if (literal.type !== type.kind) return "INCOMPATIBLE_FILTER";
  if (
    literal.type === "DECIMAL" &&
    type.kind === "DECIMAL" &&
    !decimalFits(literal.value, type)
  )
    return "DECIMAL_LITERAL_OUT_OF_RANGE";
  return undefined;
}

function resolveFilter(
  filter: SemanticFilter,
  index: number,
  fields: ReadonlyMap<string, ResolvedField>,
  issues: Issues,
): ResolvedFilter | undefined {
  const path = `$.filters[${index}]`;
  const field = fields.get(filter.fieldKey);
  if (!field) {
    issues.add(`${path}.fieldKey`, "UNKNOWN_FIELD");
    return undefined;
  }
  if (filter.op === "IS_NULL" || filter.op === "IS_NOT_NULL")
    return { field, op: filter.op };
  if (
    !["EQ", "NEQ", "IN"].includes(filter.op) &&
    !ORDERED_TYPES.has(field.semanticType.kind)
  ) {
    issues.add(`${path}.op`, "INCOMPATIBLE_FILTER");
    return undefined;
  }
  if (filter.op === "IN") {
    let valid = true;
    const values = filter.values.map((value, valueIndex) => {
      const cloned = cloneSemanticLiteral(value);
      const code = literalIssue(value, field.semanticType);
      if (code) {
        issues.add(`${path}.values[${valueIndex}]`, code);
        valid = false;
      }
      return cloned;
    });
    return valid ? { field, op: "IN", values } : undefined;
  }
  if (!("value" in filter)) throw new Error("SEMANTIC_QUERY_INCONSISTENT");
  const code = literalIssue(filter.value, field.semanticType);
  if (code) {
    issues.add(`${path}.value`, code);
    return undefined;
  }
  return {
    field,
    op: filter.op,
    value: cloneSemanticLiteral(filter.value),
  };
}

export function resolveSemanticQuery(
  query: SemanticQueryV1,
  inspection: SemanticModelInspection,
): ResolveSemanticQueryResult {
  if (inspection.revision.status !== "PUBLISHED")
    return deepFreezeResolved({
      outcome: "REVISION_NOT_PUBLISHED",
      status: inspection.revision.status,
    });

  const issues = new Issues();
  const fields = new Map(
    inspection.fields.map((field) => [field.fieldKey, resolvedField(field)]),
  );
  const inspectedMetrics = new Map(
    inspection.metrics.map((metric) => [metric.metricKey, metric]),
  );

  const metrics: ResolvedMetric[] = [];
  const selectedMetrics = new Map<string, ResolvedMetric>();
  query.metrics.forEach((metricKey, index) => {
    const metric = inspectedMetrics.get(metricKey);
    if (!metric) {
      issues.add(`$.metrics[${index}]`, "UNKNOWN_METRIC");
      return;
    }
    const resolved = resolvedMetric(metric, fields);
    metrics.push(resolved);
    selectedMetrics.set(metricKey, resolved);
  });

  const dimensions: ResolvedDimension[] = [];
  const selectedDimensions = new Map<string, ResolvedDimension>();
  (query.dimensions ?? []).forEach((fieldKey, index) => {
    const field = fields.get(fieldKey);
    if (!field) {
      issues.add(`$.dimensions[${index}]`, "UNKNOWN_FIELD");
      return;
    }
    const dimension = deepFreezeResolved({ field });
    dimensions.push(dimension);
    selectedDimensions.set(fieldKey, dimension);
  });

  const filters = (query.filters ?? []).flatMap((filter, index) => {
    const resolved = resolveFilter(filter, index, fields, issues);
    return resolved ? [resolved] : [];
  });

  const selectedMetricKeys = new Set(query.metrics);
  const selectedDimensionKeys = new Set(query.dimensions ?? []);
  const orderBy: ResolvedOrder[] = [];
  (query.orderBy ?? []).forEach((order, index) => {
    const path = `$.orderBy[${index}].target`;
    if (order.target.kind === "METRIC") {
      if (!selectedMetricKeys.has(order.target.metricKey)) {
        issues.add(path, "INVALID_ORDER");
        return;
      }
      const metric = selectedMetrics.get(order.target.metricKey);
      if (metric)
        orderBy.push({
          target: { kind: "METRIC", metric },
          direction: order.direction,
        });
      return;
    }
    if (!selectedDimensionKeys.has(order.target.fieldKey)) {
      issues.add(path, "INVALID_ORDER");
      return;
    }
    const dimension = selectedDimensions.get(order.target.fieldKey);
    if (dimension)
      orderBy.push({
        target: { kind: "DIMENSION", dimension },
        direction: order.direction,
      });
  });

  if (issues.values.length)
    return deepFreezeResolved({
      outcome: "INVALID_SEMANTIC_QUERY",
      issues: [...issues.values],
    });
  if (inspection.revision.publishedAt === null)
    throw new Error("SEMANTIC_INSPECTION_INCONSISTENT");

  return deepFreezeResolved({
    outcome: "RESOLVED",
    query: {
      version: 1,
      model: { id: inspection.model.id, name: inspection.model.name },
      revision: {
        id: inspection.revision.id,
        revisionNumber: inspection.revision.revisionNumber,
        label: inspection.revision.label,
        publishedAt: new Date(inspection.revision.publishedAt.getTime()),
      },
      dataset: { id: inspection.dataset.id, name: inspection.dataset.name },
      datasetVersion: {
        id: inspection.datasetVersion.id,
        versionNumber: inspection.datasetVersion.versionNumber,
      },
      metrics,
      dimensions,
      filters,
      orderBy,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    },
  });
}
