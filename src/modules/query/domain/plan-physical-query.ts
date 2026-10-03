import type { AuthorizedAnalyticalSource } from "../../dataset/domain/analytical-source.ts";
import { parsePhysicalType } from "../../dataset/domain/physical-type.ts";
import {
  inferScalarExpressionType,
  validateMetricExpression,
  type ScalarExpression,
} from "../../semantic/domain/metric-expression.ts";
import {
  classifyTypeCompatibility,
  validateSemanticType,
  type SemanticType,
} from "../../semantic/domain/semantic-field.ts";
import type {
  ResolvedField,
  ResolvedMetric,
  ResolvedSemanticQuery,
} from "./resolved-semantic-query.ts";
import type { SemanticLiteral } from "./semantic-query.ts";
import type {
  FiniteDoublePolicy,
  OutputDescriptor,
  PhysicalExpression,
  PhysicalFilter,
  PhysicalLiteral,
  PhysicalQueryPlan,
  PhysicalValueType,
  PlanPhysicalQueryResult,
  PlannedMetric,
  PlannedSourceField,
  SourceConversionPolicy,
} from "./physical-query-plan.ts";

const FINITE_DOUBLE: FiniteDoublePolicy = Object.freeze({
  kind: "TEXT_TO_FINITE_DOUBLE",
  overflow: "ERROR",
  underflowToZero: "ERROR",
  nonFinite: "ERROR",
});

class PlanningFailure {
  readonly result: Exclude<PlanPhysicalQueryResult, { outcome: "PLANNED" }>;

  constructor(
    result: Exclude<PlanPhysicalQueryResult, { outcome: "PLANNED" }>,
  ) {
    this.result = result;
  }
}

function inconsistent(path: string): never {
  throw new PlanningFailure({ outcome: "INCONSISTENT_RESOLVED_QUERY", path });
}

function cloneSemanticType(type: SemanticType): SemanticType {
  return type.kind === "DECIMAL"
    ? { kind: "DECIMAL", precision: type.precision, scale: type.scale }
    : { kind: type.kind };
}

function sameSemanticType(left: SemanticType, right: SemanticType): boolean {
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
    sameSemanticType(left.semanticType, right.semanticType) &&
    left.lineage.physicalName === right.lineage.physicalName &&
    left.lineage.physicalType === right.lineage.physicalType &&
    left.lineage.ordinalPosition === right.lineage.ordinalPosition
  );
}

function physicalValueType(type: SemanticType): PhysicalValueType {
  switch (type.kind) {
    case "STRING":
      return { kind: "TEXT" };
    case "BOOLEAN":
      return { kind: "BOOLEAN" };
    case "INTEGER":
      return { kind: "HUGEINT" };
    case "NUMBER":
      return { kind: "DOUBLE" };
    case "DATE":
      return { kind: "DATE" };
    case "DATETIME":
      return { kind: "TIMESTAMP" };
    case "INSTANT":
      return { kind: "TIMESTAMPTZ" };
    case "DECIMAL":
      return {
        kind: "DECIMAL",
        precision: type.precision,
        scale: type.scale,
      };
  }
}

function sourceConversion(
  physicalFamily: string,
  semantic: SemanticType,
): SourceConversionPolicy {
  const nulls = "PRESERVE" as const;
  if (semantic.kind === "STRING")
    return physicalFamily === "UUID"
      ? { kind: "UUID_TEXT", invalid: "ERROR", nulls }
      : {
          kind: "TEXT_IDENTITY",
          trim: false,
          normalizeUnicode: false,
          rejectNul: true,
          nulls,
        };
  if (semantic.kind === "BOOLEAN")
    return {
      kind: "TEXT_TO_BOOLEAN",
      acceptedTokens: ["true", "false"],
      nulls,
    };
  if (semantic.kind === "INTEGER")
    return {
      kind: "TEXT_TO_EXACT_INTEGER",
      fractionalValues: "ERROR",
      overflow: "ERROR",
      nulls,
    };
  if (semantic.kind === "DECIMAL")
    return {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: semantic.precision,
      scale: semantic.scale,
      scientificNotation: "ERROR",
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
      overflow: "ERROR",
      nulls,
    };
  if (semantic.kind === "NUMBER") return { ...FINITE_DOUBLE, nulls };
  if (semantic.kind === "DATE")
    return { kind: "TEXT_TO_DATE", format: "YYYY-MM-DD", nulls };
  if (semantic.kind === "DATETIME")
    return {
      kind: "TEXT_TO_DATETIME",
      format: "YYYY-MM-DDTHH:mm:ss[.ffffff]",
      timezone: "FORBIDDEN",
      nulls,
    };
  return {
    kind: "TEXT_TO_INSTANT",
    format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z",
    timezone: "UTC_REQUIRED",
    nulls,
  };
}

function literal(
  input: SemanticLiteral,
  targetType: SemanticType,
): PhysicalLiteral {
  if (input.type !== targetType.kind) inconsistent("$.literal.type");
  return {
    kind: "LITERAL",
    literalType: cloneSemanticType(targetType),
    value: input.value,
    resultType: physicalValueType(targetType),
    ...(targetType.kind === "NUMBER" ? { capability: FINITE_DOUBLE } : {}),
  };
}

function metricLiteral(
  expression: Extract<ScalarExpression, { kind: "literal" }>,
  targetType: SemanticType,
): PhysicalLiteral {
  return {
    kind: "LITERAL",
    literalType: cloneSemanticType(targetType),
    value: expression.value,
    resultType: physicalValueType(targetType),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function planPhysicalQuery(
  query: ResolvedSemanticQuery,
  source: AuthorizedAnalyticalSource,
): PlanPhysicalQueryResult {
  try {
    if (source.sourceType !== "CSV")
      return { outcome: "UNSUPPORTED_SOURCE_TYPE" };
    if (
      query.dataset.id !== source.datasetId ||
      query.datasetVersion.id !== source.datasetVersionId
    )
      return { outcome: "SOURCE_MISMATCH" };

    const columns = new Map<
      number,
      AuthorizedAnalyticalSource["schema"][number]
    >();
    const columnNames = new Set<string>();
    for (let index = 0; index < source.schema.length; index += 1) {
      const column = source.schema[index];
      const reparsed = parsePhysicalType(column.physicalType.name);
      const normalizedName = column.physicalName.toLowerCase();
      if (
        column.ordinalPosition !== index + 1 ||
        !column.physicalName.trim() ||
        column.physicalName.includes("\0") ||
        columnNames.has(normalizedName) ||
        !reparsed
      )
        return { outcome: "SOURCE_MISMATCH" };
      columnNames.add(normalizedName);
      columns.set(column.ordinalPosition, {
        physicalName: column.physicalName,
        physicalType: reparsed,
        ordinalPosition: column.ordinalPosition,
      });
    }
    if (
      columns.size === 0 ||
      source.expectedSizeBytes <= BigInt(0) ||
      source.expectedRowCount < BigInt(0)
    )
      return { outcome: "SOURCE_MISMATCH" };

    const fields = new Map<string, ResolvedField>();
    const registerField = (field: ResolvedField, path: string) => {
      const existing = fields.get(field.fieldKey);
      if (existing && !sameField(existing, field)) inconsistent(path);
      try {
        validateSemanticType(field.semanticType);
      } catch {
        inconsistent(`${path}.semanticType`);
      }
      fields.set(field.fieldKey, field);
    };
    query.metrics.forEach((metric, metricIndex) =>
      metric.dependencies.forEach((field, dependencyIndex) =>
        registerField(
          field,
          `$.metrics[${metricIndex}].dependencies[${dependencyIndex}]`,
        ),
      ),
    );
    query.dimensions.forEach((dimension, index) =>
      registerField(dimension.field, `$.dimensions[${index}]`),
    );
    query.filters.forEach((filter, index) =>
      registerField(filter.field, `$.filters[${index}]`),
    );

    const orderedFields = [...fields.values()].sort(
      (left, right) =>
        left.lineage.ordinalPosition - right.lineage.ordinalPosition ||
        left.fieldKey.localeCompare(right.fieldKey),
    );
    const sourceFields: PlannedSourceField[] = [];
    const sourceFieldIndexes = new Map<string, number>();
    for (const field of orderedFields) {
      const column = columns.get(field.lineage.ordinalPosition);
      if (
        !column ||
        column.physicalName !== field.lineage.physicalName ||
        column.physicalType.name !== field.lineage.physicalType
      )
        return { outcome: "SOURCE_MISMATCH" };
      let classified;
      try {
        classified = classifyTypeCompatibility(
          column.physicalType.name,
          field.semanticType,
        );
      } catch {
        inconsistent(`$.fields.${field.fieldKey}.semanticType`);
      }
      if (classified.compatibility === "INVALID")
        return {
          outcome: "UNSUPPORTED_PHYSICAL_CONVERSION",
          fieldKey: field.fieldKey,
        };
      const sourceField: PlannedSourceField = {
        fieldKey: field.fieldKey,
        columnIndex: field.lineage.ordinalPosition - 1,
        semanticType: cloneSemanticType(field.semanticType),
        persistedPhysicalType: { ...column.physicalType },
        compatibility:
          classified.compatibility === "SAFE"
            ? "EXECUTABLE_SAFE"
            : "EXECUTABLE_EXPLICIT",
        conversion: sourceConversion(
          column.physicalType.family,
          field.semanticType,
        ),
        resultType: physicalValueType(field.semanticType),
      };
      sourceFieldIndexes.set(field.fieldKey, sourceFields.length);
      sourceFields.push(sourceField);
    }

    const sourceExpression = (
      field: ResolvedField,
      path: string,
    ): Extract<PhysicalExpression, { kind: "SOURCE_FIELD" }> => {
      const index = sourceFieldIndexes.get(field.fieldKey);
      if (index === undefined) inconsistent(path);
      return {
        kind: "SOURCE_FIELD",
        sourceFieldIndex: index,
        resultType: sourceFields[index].resultType,
      };
    };

    const planMetric = (
      metric: ResolvedMetric,
      metricIndex: number,
      outputIndex: number,
    ): PlannedMetric => {
      const path = `$.metrics[${metricIndex}]`;
      const dependencyTypes = new Map<string, SemanticType>();
      for (const dependency of metric.dependencies) {
        if (dependencyTypes.has(dependency.fieldKey))
          inconsistent(`${path}.dependencies`);
        dependencyTypes.set(dependency.fieldKey, dependency.semanticType);
      }
      const validation = validateMetricExpression(
        metric.expression,
        dependencyTypes,
      );
      if (
        !validation.valid ||
        !sameSemanticType(validation.value.resultType, metric.resultType) ||
        validation.value.fieldKeys.length !== dependencyTypes.size ||
        validation.value.fieldKeys.some((key) => !dependencyTypes.has(key))
      )
        inconsistent(`${path}.expression`);

      const scalar = (
        expression: ScalarExpression,
        scalarPath: string,
      ): PhysicalExpression => {
        const inference = inferScalarExpressionType(
          expression,
          dependencyTypes,
        );
        if (!inference.valid) inconsistent(scalarPath);
        const inferredType = inference.value.type;
        if (expression.kind === "field") {
          const dependency = metric.dependencies.find(
            (field) => field.fieldKey === expression.fieldKey,
          );
          if (!dependency) inconsistent(scalarPath);
          return sourceExpression(dependency, scalarPath);
        }
        if (expression.kind === "literal")
          return metricLiteral(expression, inferredType);
        const left = scalar(expression.left, `${scalarPath}.left`);
        const right = scalar(expression.right, `${scalarPath}.right`);
        return {
          kind: "BINARY",
          op: expression.op,
          left,
          right,
          resultType: physicalValueType(inferredType),
          arithmeticPolicy:
            inferredType.kind === "DECIMAL"
              ? "EXACT_DECIMAL"
              : inferredType.kind === "NUMBER"
                ? "APPROXIMATE_DOUBLE"
                : "EXACT_INTEGER",
          overflow: "ERROR",
          requireFiniteResult: inferredType.kind === "NUMBER",
        };
      };

      const input = scalar(metric.expression.expression, `${path}.expression`);
      const cardinality = metric.expression.op !== "SUM";
      return {
        outputIndex,
        semanticType: cloneSemanticType(metric.resultType),
        expression: {
          kind: "AGGREGATE",
          op: metric.expression.op,
          expression: input,
          resultType: cardinality
            ? { kind: "BIGINT" }
            : physicalValueType(metric.resultType),
          aggregationPolicy: cardinality
            ? "CARDINALITY"
            : metric.resultType.kind === "DECIMAL"
              ? "EXACT_DECIMAL"
              : metric.resultType.kind === "NUMBER"
                ? "APPROXIMATE_DOUBLE"
                : "EXACT_INTEGER",
          overflow: "ERROR",
          requireFiniteResult: metric.resultType.kind === "NUMBER",
        },
      };
    };

    const output: OutputDescriptor[] = [];
    const dimensions = query.dimensions.map((dimension, index) => {
      const resultType = physicalValueType(dimension.field.semanticType);
      output.push({
        outputIndex: index,
        role: "DIMENSION",
        semanticKey: {
          kind: "FIELD",
          fieldKey: dimension.field.fieldKey,
        },
        name: dimension.field.name,
        label: dimension.field.label,
        semanticType: cloneSemanticType(dimension.field.semanticType),
        physicalType: resultType,
      });
      return {
        outputIndex: index,
        expression: sourceExpression(dimension.field, `$.dimensions[${index}]`),
        semanticType: cloneSemanticType(dimension.field.semanticType),
      };
    });
    const metrics = query.metrics.map((metric, index) => {
      const outputIndex = dimensions.length + index;
      const planned = planMetric(metric, index, outputIndex);
      output.push({
        outputIndex,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: metric.metricKey },
        name: metric.name,
        label: metric.label,
        semanticType: cloneSemanticType(metric.resultType),
        physicalType: planned.expression.resultType,
      });
      return planned;
    });

    const filters: PhysicalFilter[] = query.filters.map((filter, index) => {
      const field = sourceExpression(filter.field, `$.filters[${index}]`);
      if (filter.op === "IS_NULL" || filter.op === "IS_NOT_NULL")
        return { field, op: filter.op };
      if (filter.op === "IN")
        return {
          field,
          op: filter.op,
          values: filter.values.map((value) =>
            literal(value, filter.field.semanticType),
          ),
        };
      if (!("value" in filter)) inconsistent(`$.filters[${index}]`);
      return {
        field,
        op: filter.op,
        value: literal(filter.value, filter.field.semanticType),
      };
    });

    const dimensionOutputs = new Map(
      query.dimensions.map((item, index) => [item.field.fieldKey, index]),
    );
    const metricOutputs = new Map(
      query.metrics.map((item, index) => [
        item.metricKey,
        dimensions.length + index,
      ]),
    );
    const orderBy = query.orderBy.map((order, index) => {
      const outputIndex =
        order.target.kind === "DIMENSION"
          ? dimensionOutputs.get(order.target.dimension.field.fieldKey)
          : metricOutputs.get(order.target.metric.metricKey);
      if (outputIndex === undefined) inconsistent(`$.orderBy[${index}]`);
      return {
        outputIndex,
        direction: order.direction,
        nulls: "LAST" as const,
      };
    });

    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000)
    )
      inconsistent("$.limit");

    const plan: PhysicalQueryPlan = {
      version: 1,
      context: {
        semanticModelId: query.model.id,
        semanticModelRevisionId: query.revision.id,
        datasetId: query.dataset.id,
        datasetVersionId: query.datasetVersion.id,
      },
      source: {
        kind: "CSV",
        material: source.material,
        materialIdentity: { ...source.materialIdentity },
        expectedSizeBytes: source.expectedSizeBytes,
        expectedRowCount: source.expectedRowCount,
        columns: source.schema.map((column) => ({
          physicalName: column.physicalName,
          ordinalPosition: column.ordinalPosition,
        })),
        readMode: "TEXT",
        dialect: {
          encoding: "UTF-8",
          delimiter: ",",
          quote: '"',
          escape: '"',
          header: true,
          strict: true,
          emptyField: "NULL",
          quotedEmptyField: "NULL",
        },
        schemaValidation: {
          headerRequired: true,
          exactColumnCount: true,
          exactNamesAndOrder: true,
          duplicateNames: "ERROR",
          invalidRowShape: "ERROR",
          expectedRowCount: source.expectedRowCount,
        },
      },
      sourceFields,
      dimensions,
      metrics,
      filters,
      orderBy,
      ...(query.limit === undefined ? {} : { semanticLimit: query.limit }),
      output,
    };
    return deepFreeze({ outcome: "PLANNED", plan });
  } catch (error) {
    return error instanceof PlanningFailure
      ? error.result
      : { outcome: "INCONSISTENT_RESOLVED_QUERY", path: "$" };
  }
}
