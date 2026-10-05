import type { QueryExplanation } from "../../query/domain/query-explanation.ts";
import type { QueryResult } from "../../query/domain/query-result.ts";
import type { ResolvedSemanticQuery } from "../../query/domain/resolved-semantic-query.ts";
import type { SemanticType } from "../../semantic/domain/semantic-field.ts";

export const MAX_VISUALIZATION_SPEC_BYTES = 4 * 1024;
export const MAX_VISUALIZATION_ISSUES = 16;

export type VisualizationOutputReference = Readonly<{
  role: "DIMENSION" | "METRIC";
  key: string;
}>;

export type VisualizationSpecV1 =
  | Readonly<{
      version: 1;
      type: "KPI";
      value: VisualizationOutputReference;
    }>
  | Readonly<{ version: 1; type: "TABLE" }>
  | Readonly<{
      version: 1;
      type: "BAR";
      category: VisualizationOutputReference;
      value: VisualizationOutputReference;
    }>
  | Readonly<{
      version: 1;
      type: "LINE";
      x: VisualizationOutputReference;
      y: VisualizationOutputReference;
    }>;

export type VisualizationSpecIssueCode =
  | "INVALID_TYPE"
  | "UNKNOWN_PROPERTY"
  | "MISSING_PROPERTY"
  | "UNSUPPORTED_VERSION"
  | "INVALID_VISUALIZATION_TYPE"
  | "INVALID_OUTPUT_ROLE"
  | "INVALID_KEY"
  | "SPEC_TOO_LARGE"
  | "ISSUE_LIMIT_REACHED";

export type VisualizationSpecIssue = Readonly<{
  path: string;
  code: VisualizationSpecIssueCode;
  message: string;
}>;

export type ParseVisualizationSpecResult =
  | Readonly<{
      valid: true;
      spec: VisualizationSpecV1;
      canonicalJson: string;
      canonicalBytes: number;
    }>
  | Readonly<{
      valid: false;
      error: Readonly<{
        code: "INVALID_VISUALIZATION_SPEC";
        issues: readonly VisualizationSpecIssue[];
      }>;
    }>;

export type VisualizationCompatibilitySource =
  | Readonly<{
      phase: "PRE_EXECUTION";
      query: ResolvedSemanticQuery;
    }>
  | Readonly<{
      phase: "POST_EXECUTION";
      columns: QueryResult["columns"];
      orderBy: QueryExplanation["orderBy"];
    }>;

export type VisualizationCompatibilityIssueCode =
  | "OUTPUT_COUNT_INCOMPATIBLE"
  | "OUTPUT_NOT_FOUND"
  | "OUTPUT_ROLE_MISMATCH"
  | "OUTPUT_TYPE_INCOMPATIBLE"
  | "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER"
  | "ISSUE_LIMIT_REACHED";

export type VisualizationCompatibilityIssue = Readonly<{
  path: string;
  code: VisualizationCompatibilityIssueCode;
  message: string;
}>;

export type VisualizationCompatibilityResult =
  | Readonly<{ compatible: true }>
  | Readonly<{
      compatible: false;
      issues: readonly VisualizationCompatibilityIssue[];
    }>;

export type VisualizationRecommendationReason =
  | "SINGLE_NUMERIC_METRIC"
  | "CATEGORICAL_DIMENSION_WITH_NUMERIC_METRIC"
  | "ORDERED_TEMPORAL_DIMENSION_WITH_NUMERIC_METRIC"
  | "UNIVERSAL_TABLE_FALLBACK";

export type VisualizationRecommendation = Readonly<{
  spec: VisualizationSpecV1;
  reason: VisualizationRecommendationReason;
}>;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TYPES = new Set(["KPI", "TABLE", "BAR", "LINE"]);
const ROOT_PROPERTIES = ["version", "type", "value", "category", "x", "y"];
const NUMERIC_TYPES = new Set<SemanticType["kind"]>([
  "INTEGER",
  "DECIMAL",
  "NUMBER",
]);
const CATEGORICAL_TYPES = new Set<SemanticType["kind"]>(["STRING", "BOOLEAN"]);
const TEMPORAL_TYPES = new Set<SemanticType["kind"]>([
  "DATE",
  "DATETIME",
  "INSTANT",
]);

const PARSE_MESSAGES: Record<VisualizationSpecIssueCode, string> = {
  INVALID_TYPE: "O valor possui um tipo ou formato estrutural invalido.",
  UNKNOWN_PROPERTY: "O objeto contem uma propriedade nao suportada.",
  MISSING_PROPERTY: "Uma propriedade obrigatoria esta ausente.",
  UNSUPPORTED_VERSION: "A versao da visualizacao nao e suportada.",
  INVALID_VISUALIZATION_TYPE: "O tipo de visualizacao nao e suportado.",
  INVALID_OUTPUT_ROLE: "O papel do output nao e suportado.",
  INVALID_KEY: "A chave de output e invalida.",
  SPEC_TOO_LARGE: "A especificacao excede o tamanho maximo permitido.",
  ISSUE_LIMIT_REACHED: "A especificacao possui erros adicionais nao listados.",
};

const COMPATIBILITY_MESSAGES: Record<
  VisualizationCompatibilityIssueCode,
  string
> = {
  OUTPUT_COUNT_INCOMPATIBLE:
    "A quantidade de outputs nao e compativel com a visualizacao.",
  OUTPUT_NOT_FOUND: "O output referenciado nao foi encontrado.",
  OUTPUT_ROLE_MISMATCH:
    "O papel do output nao e compativel com a visualizacao.",
  OUTPUT_TYPE_INCOMPATIBLE:
    "O tipo semantico do output nao e compativel com a visualizacao.",
  LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER:
    "LINE exige a dimension temporal como primeira ordenacao ascendente.",
  ISSUE_LIMIT_REACHED:
    "A compatibilidade possui erros adicionais nao listados.",
};

type ObjectView = {
  keys: ReadonlySet<string>;
  values: Record<string, unknown>;
};

type OutputShape = Readonly<{
  outputs: readonly Readonly<{
    role: "DIMENSION" | "METRIC";
    key: string;
    semanticType: SemanticType;
  }>[];
  orderBy: readonly Readonly<{
    role: "DIMENSION" | "METRIC";
    key: string;
    direction: "ASC" | "DESC";
  }>[];
}>;

class IssueCollector<Code extends string> {
  readonly values: { path: string; code: Code; message: string }[] = [];
  private full = false;
  private readonly messages: Readonly<Record<Code, string>>;

  constructor(messages: Readonly<Record<Code, string>>) {
    this.messages = messages;
  }

  add(path: string, code: Code): void {
    if (this.full) return;
    if (this.values.length === MAX_VISUALIZATION_ISSUES - 1) {
      const limitCode = "ISSUE_LIMIT_REACHED" as Code;
      this.values.push({
        path: "$",
        code: limitCode,
        message: this.messages[limitCode],
      });
      this.full = true;
      return;
    }
    this.values.push({ path, code, message: this.messages[code] });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function objectView(
  input: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: IssueCollector<VisualizationSpecIssueCode>,
): ObjectView | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined,
    )
  ) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  const keys = new Set(Object.keys(descriptors));
  const allowedSet = new Set(allowed);
  if ([...keys].some((key) => !allowedSet.has(key)))
    issues.add(path, "UNKNOWN_PROPERTY");
  for (const key of required)
    if (!keys.has(key)) issues.add(`${path}.${key}`, "MISSING_PROPERTY");
  return {
    keys,
    values: Object.fromEntries(
      allowed
        .filter((key) => keys.has(key))
        .map((key) => [key, descriptors[key].value]),
    ),
  };
}

function outputReference(
  input: unknown,
  path: string,
  issues: IssueCollector<VisualizationSpecIssueCode>,
): VisualizationOutputReference | undefined {
  const view = objectView(
    input,
    path,
    ["role", "key"],
    ["role", "key"],
    issues,
  );
  if (!view) return undefined;
  const role = view.values.role;
  const key = view.values.key;
  if (role !== "DIMENSION" && role !== "METRIC")
    issues.add(`${path}.role`, "INVALID_OUTPUT_ROLE");
  if (typeof key !== "string" || !UUID.test(key))
    issues.add(`${path}.key`, "INVALID_KEY");
  if (
    (role !== "DIMENSION" && role !== "METRIC") ||
    typeof key !== "string" ||
    !UUID.test(key)
  )
    return undefined;
  return { role, key: key.toLowerCase() };
}

function parseFailure(
  issues: IssueCollector<VisualizationSpecIssueCode>,
): ParseVisualizationSpecResult {
  return deepFreeze({
    valid: false,
    error: { code: "INVALID_VISUALIZATION_SPEC", issues: [...issues.values] },
  });
}

export function parseVisualizationSpec(
  input: unknown,
): ParseVisualizationSpecResult {
  const issues = new IssueCollector(PARSE_MESSAGES);
  try {
    const root = objectView(
      input,
      "$",
      ROOT_PROPERTIES,
      ["version", "type"],
      issues,
    );
    if (!root) return parseFailure(issues);

    if (root.values.version !== 1)
      issues.add(
        "$.version",
        typeof root.values.version === "number" &&
          Number.isInteger(root.values.version)
          ? "UNSUPPORTED_VERSION"
          : "INVALID_TYPE",
      );
    const type = root.values.type;
    if (typeof type !== "string" || !TYPES.has(type))
      issues.add("$.type", "INVALID_VISUALIZATION_TYPE");

    const expectedByType: Record<string, readonly string[]> = {
      KPI: ["version", "type", "value"],
      TABLE: ["version", "type"],
      BAR: ["version", "type", "category", "value"],
      LINE: ["version", "type", "x", "y"],
    };
    const expected =
      typeof type === "string" ? expectedByType[type] : undefined;
    if (expected) {
      if (
        [...root.keys].some(
          (key) => ROOT_PROPERTIES.includes(key) && !expected.includes(key),
        )
      )
        issues.add("$", "UNKNOWN_PROPERTY");
      for (const key of expected.filter(
        (key) => key !== "version" && key !== "type",
      ))
        if (!root.keys.has(key)) issues.add(`$.${key}`, "MISSING_PROPERTY");
    }

    let spec: VisualizationSpecV1 | undefined;
    if (type === "KPI") {
      const value = root.keys.has("value")
        ? outputReference(root.values.value, "$.value", issues)
        : undefined;
      if (value) spec = { version: 1, type, value };
    } else if (type === "TABLE") {
      spec = { version: 1, type };
    } else if (type === "BAR") {
      const category = root.keys.has("category")
        ? outputReference(root.values.category, "$.category", issues)
        : undefined;
      const value = root.keys.has("value")
        ? outputReference(root.values.value, "$.value", issues)
        : undefined;
      if (category && value) spec = { version: 1, type, category, value };
    } else if (type === "LINE") {
      const x = root.keys.has("x")
        ? outputReference(root.values.x, "$.x", issues)
        : undefined;
      const y = root.keys.has("y")
        ? outputReference(root.values.y, "$.y", issues)
        : undefined;
      if (x && y) spec = { version: 1, type, x, y };
    }

    if (issues.values.length || !spec) return parseFailure(issues);
    const canonicalJson = JSON.stringify(spec);
    const canonicalBytes = new TextEncoder().encode(canonicalJson).byteLength;
    if (canonicalBytes > MAX_VISUALIZATION_SPEC_BYTES) {
      issues.add("$", "SPEC_TOO_LARGE");
      return parseFailure(issues);
    }
    return deepFreeze({ valid: true, spec, canonicalJson, canonicalBytes });
  } catch {
    if (!issues.values.length) issues.add("$", "INVALID_TYPE");
    return parseFailure(issues);
  }
}

function shape(source: VisualizationCompatibilitySource): OutputShape {
  if (source.phase === "PRE_EXECUTION") {
    return {
      outputs: [
        ...source.query.dimensions.map(({ field }) => ({
          role: "DIMENSION" as const,
          key: field.fieldKey,
          semanticType: field.semanticType,
        })),
        ...source.query.metrics.map((metric) => ({
          role: "METRIC" as const,
          key: metric.metricKey,
          semanticType: metric.resultType,
        })),
      ],
      orderBy: source.query.orderBy.map((order) =>
        order.target.kind === "DIMENSION"
          ? {
              role: "DIMENSION" as const,
              key: order.target.dimension.field.fieldKey,
              direction: order.direction,
            }
          : {
              role: "METRIC" as const,
              key: order.target.metric.metricKey,
              direction: order.direction,
            },
      ),
    };
  }
  return {
    outputs: source.columns.map((column) => ({
      role: column.role,
      key: column.key,
      semanticType: column.semanticType,
    })),
    orderBy: source.orderBy.map((order) => ({
      role: order.target.role,
      key: order.target.key,
      direction: order.direction,
    })),
  };
}

function compatibleOutput(
  shapeValue: OutputShape,
  reference: VisualizationOutputReference,
  expectedRole: "DIMENSION" | "METRIC",
  acceptedTypes: ReadonlySet<SemanticType["kind"]>,
  path: string,
  issues: IssueCollector<VisualizationCompatibilityIssueCode>,
) {
  const exact = shapeValue.outputs.find(
    (output) => output.key === reference.key && output.role === reference.role,
  );
  const sameKey = shapeValue.outputs.find(
    (output) => output.key === reference.key,
  );
  if (!sameKey) {
    issues.add(path, "OUTPUT_NOT_FOUND");
    return undefined;
  }
  if (reference.role !== expectedRole || !exact) {
    issues.add(path, "OUTPUT_ROLE_MISMATCH");
    return undefined;
  }
  if (!acceptedTypes.has(exact.semanticType.kind)) {
    issues.add(path, "OUTPUT_TYPE_INCOMPATIBLE");
    return undefined;
  }
  return exact;
}

function outputCounts(shapeValue: OutputShape) {
  let dimensions = 0;
  let metrics = 0;
  for (const output of shapeValue.outputs) {
    if (output.role === "DIMENSION") dimensions += 1;
    else metrics += 1;
  }
  return { dimensions, metrics };
}

function ascendingFirstDimension(
  shapeValue: OutputShape,
  key: string,
): boolean {
  const first = shapeValue.orderBy[0];
  return (
    first?.role === "DIMENSION" &&
    first.key === key &&
    first.direction === "ASC"
  );
}

function compatibility(
  spec: VisualizationSpecV1,
  shapeValue: OutputShape,
): VisualizationCompatibilityResult {
  const issues = new IssueCollector(COMPATIBILITY_MESSAGES);
  const counts = outputCounts(shapeValue);
  if (spec.type === "TABLE") {
    if (shapeValue.outputs.length < 1)
      issues.add("$", "OUTPUT_COUNT_INCOMPATIBLE");
  } else if (spec.type === "KPI") {
    if (counts.dimensions !== 0 || counts.metrics !== 1)
      issues.add("$", "OUTPUT_COUNT_INCOMPATIBLE");
    compatibleOutput(
      shapeValue,
      spec.value,
      "METRIC",
      NUMERIC_TYPES,
      "$.value",
      issues,
    );
  } else if (spec.type === "BAR") {
    if (counts.dimensions !== 1 || counts.metrics !== 1)
      issues.add("$", "OUTPUT_COUNT_INCOMPATIBLE");
    compatibleOutput(
      shapeValue,
      spec.category,
      "DIMENSION",
      CATEGORICAL_TYPES,
      "$.category",
      issues,
    );
    compatibleOutput(
      shapeValue,
      spec.value,
      "METRIC",
      NUMERIC_TYPES,
      "$.value",
      issues,
    );
  } else {
    if (counts.dimensions !== 1 || counts.metrics !== 1)
      issues.add("$", "OUTPUT_COUNT_INCOMPATIBLE");
    const x = compatibleOutput(
      shapeValue,
      spec.x,
      "DIMENSION",
      TEMPORAL_TYPES,
      "$.x",
      issues,
    );
    compatibleOutput(
      shapeValue,
      spec.y,
      "METRIC",
      NUMERIC_TYPES,
      "$.y",
      issues,
    );
    if (x && !ascendingFirstDimension(shapeValue, x.key))
      issues.add("$.x", "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER");
  }
  return issues.values.length
    ? deepFreeze({ compatible: false, issues: [...issues.values] })
    : deepFreeze({ compatible: true });
}

export function validateVisualizationCompatibility(
  spec: VisualizationSpecV1,
  source: VisualizationCompatibilitySource,
): VisualizationCompatibilityResult {
  return compatibility(spec, shape(source));
}

function reference(
  role: "DIMENSION" | "METRIC",
  key: string,
): VisualizationOutputReference {
  return { role, key };
}

export function recommendVisualization(
  query: ResolvedSemanticQuery,
): VisualizationRecommendation {
  const source: VisualizationCompatibilitySource = {
    phase: "PRE_EXECUTION",
    query,
  };
  const shapeValue = shape(source);
  const counts = outputCounts(shapeValue);
  if (shapeValue.outputs.length < 1)
    throw new TypeError("ResolvedSemanticQuery sem outputs.");
  const dimension = shapeValue.outputs.find(
    (output) => output.role === "DIMENSION",
  );
  const metric = shapeValue.outputs.find((output) => output.role === "METRIC");

  let recommendation: VisualizationRecommendation;
  if (
    counts.dimensions === 0 &&
    counts.metrics === 1 &&
    metric &&
    NUMERIC_TYPES.has(metric.semanticType.kind)
  ) {
    recommendation = {
      spec: {
        version: 1,
        type: "KPI",
        value: reference("METRIC", metric.key),
      },
      reason: "SINGLE_NUMERIC_METRIC",
    };
  } else if (
    counts.dimensions === 1 &&
    counts.metrics === 1 &&
    dimension &&
    metric &&
    CATEGORICAL_TYPES.has(dimension.semanticType.kind) &&
    NUMERIC_TYPES.has(metric.semanticType.kind)
  ) {
    recommendation = {
      spec: {
        version: 1,
        type: "BAR",
        category: reference("DIMENSION", dimension.key),
        value: reference("METRIC", metric.key),
      },
      reason: "CATEGORICAL_DIMENSION_WITH_NUMERIC_METRIC",
    };
  } else if (
    counts.dimensions === 1 &&
    counts.metrics === 1 &&
    dimension &&
    metric &&
    TEMPORAL_TYPES.has(dimension.semanticType.kind) &&
    NUMERIC_TYPES.has(metric.semanticType.kind) &&
    ascendingFirstDimension(shapeValue, dimension.key)
  ) {
    recommendation = {
      spec: {
        version: 1,
        type: "LINE",
        x: reference("DIMENSION", dimension.key),
        y: reference("METRIC", metric.key),
      },
      reason: "ORDERED_TEMPORAL_DIMENSION_WITH_NUMERIC_METRIC",
    };
  } else {
    recommendation = {
      spec: { version: 1, type: "TABLE" },
      reason: "UNIVERSAL_TABLE_FALLBACK",
    };
  }
  return deepFreeze(recommendation);
}
