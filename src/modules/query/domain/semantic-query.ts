export const MAX_QUERY_METRICS = 4;
export const MAX_QUERY_DIMENSIONS = 3;
export const MAX_QUERY_FILTERS = 8;
export const MAX_QUERY_ORDER_BY = 3;
export const MAX_QUERY_IN_VALUES = 50;
export const MAX_SEMANTIC_QUERY_BYTES = 16 * 1024;
export const MAX_SEMANTIC_QUERY_ISSUES = 64;

export type IntegerLiteral = Readonly<{ type: "INTEGER"; value: string }>;
export type DecimalLiteral = Readonly<{ type: "DECIMAL"; value: string }>;
export type NumberLiteral = Readonly<{ type: "NUMBER"; value: string }>;
export type StringLiteral = Readonly<{ type: "STRING"; value: string }>;
export type BooleanLiteral = Readonly<{ type: "BOOLEAN"; value: boolean }>;
export type DateLiteral = Readonly<{ type: "DATE"; value: string }>;
export type DateTimeLiteral = Readonly<{ type: "DATETIME"; value: string }>;
export type InstantLiteral = Readonly<{ type: "INSTANT"; value: string }>;

export type SemanticLiteral =
  | IntegerLiteral
  | DecimalLiteral
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | DateLiteral
  | DateTimeLiteral
  | InstantLiteral;

export type SemanticFilter =
  | Readonly<{
      fieldKey: string;
      op: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE";
      value: SemanticLiteral;
    }>
  | Readonly<{
      fieldKey: string;
      op: "IN";
      values: readonly SemanticLiteral[];
    }>
  | Readonly<{
      fieldKey: string;
      op: "IS_NULL" | "IS_NOT_NULL";
    }>;

export type SemanticOrderTarget =
  | Readonly<{ kind: "METRIC"; metricKey: string }>
  | Readonly<{ kind: "DIMENSION"; fieldKey: string }>;

export type SemanticOrder = Readonly<{
  target: SemanticOrderTarget;
  direction: "ASC" | "DESC";
}>;

export type SemanticQueryV1 = Readonly<{
  version: 1;
  metrics: readonly string[];
  dimensions?: readonly string[];
  filters?: readonly SemanticFilter[];
  orderBy?: readonly SemanticOrder[];
  limit?: number;
}>;

export type SemanticQueryIssueCode =
  | "INVALID_TYPE"
  | "UNKNOWN_PROPERTY"
  | "MISSING_PROPERTY"
  | "UNSUPPORTED_VERSION"
  | "ARRAY_LIMIT_EXCEEDED"
  | "INVALID_KEY"
  | "DUPLICATE_KEY"
  | "INVALID_OPERATOR"
  | "INVALID_LITERAL"
  | "INVALID_TEMPORAL"
  | "INVALID_LIMIT"
  | "QUERY_TOO_LARGE"
  | "ISSUE_LIMIT_REACHED";

export type SemanticQueryIssue = Readonly<{
  path: string;
  code: SemanticQueryIssueCode;
  message: string;
}>;

export type ParseSemanticQueryResult =
  | Readonly<{
      valid: true;
      query: SemanticQueryV1;
      canonicalJson: string;
      canonicalBytes: number;
    }>
  | Readonly<{
      valid: false;
      error: Readonly<{
        code: "INVALID_QUERY";
        issues: readonly SemanticQueryIssue[];
      }>;
    }>;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e-?(?:0|[1-9][0-9]*))?$/;
const NEGATIVE_NUMBER_ZERO = /^-0(?:\.0+)?(?:e-?(?:0|[1-9][0-9]*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const MESSAGES: Record<SemanticQueryIssueCode, string> = {
  INVALID_TYPE: "O valor possui um tipo ou formato estrutural invalido.",
  UNKNOWN_PROPERTY: "O objeto contem uma propriedade nao suportada.",
  MISSING_PROPERTY: "Uma propriedade obrigatoria esta ausente.",
  UNSUPPORTED_VERSION: "A versao da consulta nao e suportada.",
  ARRAY_LIMIT_EXCEEDED:
    "A quantidade de itens esta fora dos limites permitidos.",
  INVALID_KEY: "A chave informada e invalida.",
  DUPLICATE_KEY: "A chave esta duplicada.",
  INVALID_OPERATOR: "O operador informado nao e suportado.",
  INVALID_LITERAL: "O literal informado e invalido.",
  INVALID_TEMPORAL: "O literal temporal informado e invalido.",
  INVALID_LIMIT: "O limite semantico informado e invalido.",
  QUERY_TOO_LARGE: "A consulta excede o tamanho maximo permitido.",
  ISSUE_LIMIT_REACHED: "A consulta possui erros adicionais nao listados.",
};

type ObjectView = {
  keys: ReadonlySet<string>;
  values: Record<string, unknown>;
};

class Issues {
  readonly values: SemanticQueryIssue[] = [];
  private full = false;

  add(path: string, code: SemanticQueryIssueCode): void {
    if (this.full) return;
    if (this.values.length === MAX_SEMANTIC_QUERY_ISSUES - 1) {
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

function objectView(
  input: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: Issues,
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

function key(input: unknown, path: string, issues: Issues): string | undefined {
  if (typeof input !== "string" || !UUID.test(input)) {
    issues.add(path, "INVALID_KEY");
    return undefined;
  }
  return input.toLowerCase();
}

function keyedArray(
  input: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: Issues,
): string[] | undefined {
  if (!Array.isArray(input)) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  if (input.length < minimum || input.length > maximum)
    issues.add(path, "ARRAY_LIMIT_EXCEEDED");
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(input.length, maximum); index += 1) {
    const value = key(input[index], `${path}[${index}]`, issues);
    if (value === undefined) continue;
    if (seen.has(value)) issues.add(`${path}[${index}]`, "DUPLICATE_KEY");
    else seen.add(value);
    parsed.push(value);
  }
  return parsed;
}

function validDate(
  yearText: string,
  monthText: string,
  dayText: string,
): boolean {
  const year = parseInt(yearText, 10);
  const month = parseInt(monthText, 10);
  const day = parseInt(dayText, 10);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function validTemporal(value: string, kind: "DATE" | "DATETIME" | "INSTANT") {
  const match =
    kind === "DATE"
      ? DATE.exec(value)
      : kind === "DATETIME"
        ? DATETIME.exec(value)
        : INSTANT.exec(value);
  if (!match || !validDate(match[1], match[2], match[3])) return false;
  if (kind === "DATE") return true;
  return (
    Number.parseInt(match[4], 10) <= 23 &&
    Number.parseInt(match[5], 10) <= 59 &&
    Number.parseInt(match[6], 10) <= 59
  );
}

function literal(
  input: unknown,
  path: string,
  issues: Issues,
): SemanticLiteral | undefined {
  const view = objectView(
    input,
    path,
    ["type", "value"],
    ["type", "value"],
    issues,
  );
  if (!view) return undefined;
  const type = view.values.type;
  const value = view.values.value;
  if (typeof type !== "string") {
    issues.add(`${path}.type`, "INVALID_LITERAL");
    return undefined;
  }
  if (type === "BOOLEAN") {
    if (typeof value !== "boolean") {
      issues.add(`${path}.value`, "INVALID_LITERAL");
      return undefined;
    }
    return { type, value };
  }
  if (typeof value !== "string") {
    issues.add(`${path}.value`, "INVALID_LITERAL");
    return undefined;
  }
  if (type === "STRING") {
    if (
      !value.isWellFormed() ||
      value.includes("\0") ||
      new TextEncoder().encode(value).byteLength > 4096
    ) {
      issues.add(`${path}.value`, "INVALID_LITERAL");
      return undefined;
    }
    return { type, value };
  }
  if (type === "INTEGER") {
    if (
      !INTEGER.test(value) ||
      value === "-0" ||
      value.replace("-", "").length > 38
    ) {
      issues.add(`${path}.value`, "INVALID_LITERAL");
      return undefined;
    }
    return { type, value };
  }
  if (type === "DECIMAL") {
    const match = DECIMAL.exec(value);
    if (match) {
      const unsigned = value.replace("-", "");
      const [integer, fraction] = unsigned.split(".");
      const precision =
        (integer === "0" ? 0 : integer.length) + fraction.length;
      if (!/^-0\.0+$/.test(value) && Math.max(1, precision) <= 38)
        return { type, value };
    }
    issues.add(`${path}.value`, "INVALID_LITERAL");
    return undefined;
  }
  if (type === "NUMBER") {
    if (
      value.length <= 64 &&
      NUMBER.test(value) &&
      !NEGATIVE_NUMBER_ZERO.test(value)
    )
      return { type, value };
    issues.add(`${path}.value`, "INVALID_LITERAL");
    return undefined;
  }
  if (type === "DATE" || type === "DATETIME" || type === "INSTANT") {
    if (validTemporal(value, type)) return { type, value } as SemanticLiteral;
    issues.add(`${path}.value`, "INVALID_TEMPORAL");
    return undefined;
  }
  issues.add(`${path}.type`, "INVALID_LITERAL");
  return undefined;
}

function filters(
  input: unknown,
  path: string,
  issues: Issues,
): SemanticFilter[] | undefined {
  if (!Array.isArray(input)) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  if (input.length > MAX_QUERY_FILTERS)
    issues.add(path, "ARRAY_LIMIT_EXCEEDED");
  const parsed: SemanticFilter[] = [];
  for (
    let index = 0;
    index < Math.min(input.length, MAX_QUERY_FILTERS);
    index += 1
  ) {
    const itemPath = `${path}[${index}]`;
    const view = objectView(
      input[index],
      itemPath,
      ["fieldKey", "op", "value", "values"],
      ["fieldKey", "op"],
      issues,
    );
    if (!view) continue;
    const fieldKey = key(view.values.fieldKey, `${itemPath}.fieldKey`, issues);
    const op = view.values.op;
    if (
      typeof op !== "string" ||
      ![
        "EQ",
        "NEQ",
        "GT",
        "GTE",
        "LT",
        "LTE",
        "IN",
        "IS_NULL",
        "IS_NOT_NULL",
      ].includes(op)
    ) {
      issues.add(`${itemPath}.op`, "INVALID_OPERATOR");
      continue;
    }
    const expected =
      op === "IN"
        ? ["fieldKey", "op", "values"]
        : op === "IS_NULL" || op === "IS_NOT_NULL"
          ? ["fieldKey", "op"]
          : ["fieldKey", "op", "value"];
    if ([...view.keys].some((name) => !expected.includes(name)))
      issues.add(itemPath, "UNKNOWN_PROPERTY");
    for (const name of expected)
      if (!view.keys.has(name))
        issues.add(`${itemPath}.${name}`, "MISSING_PROPERTY");
    if (!fieldKey) continue;
    if (op === "IS_NULL" || op === "IS_NOT_NULL") {
      parsed.push({ fieldKey, op });
      continue;
    }
    if (op === "IN") {
      const values = view.values.values;
      if (!Array.isArray(values)) {
        issues.add(`${itemPath}.values`, "INVALID_TYPE");
        continue;
      }
      if (values.length < 1 || values.length > MAX_QUERY_IN_VALUES)
        issues.add(`${itemPath}.values`, "ARRAY_LIMIT_EXCEEDED");
      const parsedValues: SemanticLiteral[] = [];
      for (
        let valueIndex = 0;
        valueIndex < Math.min(values.length, MAX_QUERY_IN_VALUES);
        valueIndex += 1
      ) {
        const parsedValue = literal(
          values[valueIndex],
          `${itemPath}.values[${valueIndex}]`,
          issues,
        );
        if (parsedValue) parsedValues.push(parsedValue);
      }
      parsed.push({ fieldKey, op, values: parsedValues });
      continue;
    }
    const value = literal(view.values.value, `${itemPath}.value`, issues);
    if (value)
      parsed.push({
        fieldKey,
        op: op as "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE",
        value,
      });
  }
  return parsed;
}

function orderBy(
  input: unknown,
  path: string,
  issues: Issues,
): SemanticOrder[] | undefined {
  if (!Array.isArray(input)) {
    issues.add(path, "INVALID_TYPE");
    return undefined;
  }
  if (input.length > MAX_QUERY_ORDER_BY)
    issues.add(path, "ARRAY_LIMIT_EXCEEDED");
  const parsed: SemanticOrder[] = [];
  const seen = new Set<string>();
  for (
    let index = 0;
    index < Math.min(input.length, MAX_QUERY_ORDER_BY);
    index += 1
  ) {
    const itemPath = `${path}[${index}]`;
    const view = objectView(
      input[index],
      itemPath,
      ["target", "direction"],
      ["target", "direction"],
      issues,
    );
    if (!view) continue;
    const targetView = objectView(
      view.values.target,
      `${itemPath}.target`,
      ["kind", "metricKey", "fieldKey"],
      ["kind"],
      issues,
    );
    const direction = view.values.direction;
    if (direction !== "ASC" && direction !== "DESC")
      issues.add(`${itemPath}.direction`, "INVALID_OPERATOR");
    if (!targetView || (direction !== "ASC" && direction !== "DESC")) continue;
    const kind = targetView.values.kind;
    const property =
      kind === "METRIC"
        ? "metricKey"
        : kind === "DIMENSION"
          ? "fieldKey"
          : undefined;
    if (!property) {
      issues.add(`${itemPath}.target.kind`, "INVALID_TYPE");
      continue;
    }
    const expected = ["kind", property];
    if ([...targetView.keys].some((name) => !expected.includes(name)))
      issues.add(`${itemPath}.target`, "UNKNOWN_PROPERTY");
    if (!targetView.keys.has(property))
      issues.add(`${itemPath}.target.${property}`, "MISSING_PROPERTY");
    const parsedKey = key(
      targetView.values[property],
      `${itemPath}.target.${property}`,
      issues,
    );
    if (!parsedKey) continue;
    const identity = `${kind}:${parsedKey}`;
    if (seen.has(identity)) issues.add(itemPath, "DUPLICATE_KEY");
    else seen.add(identity);
    const target: SemanticOrderTarget =
      kind === "METRIC"
        ? { kind: "METRIC", metricKey: parsedKey }
        : { kind: "DIMENSION", fieldKey: parsedKey };
    parsed.push({ target, direction });
  }
  return parsed;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function failure(issues: Issues): ParseSemanticQueryResult {
  return deepFreeze({
    valid: false,
    error: { code: "INVALID_QUERY", issues: [...issues.values] },
  });
}

export function parseSemanticQuery(input: unknown): ParseSemanticQueryResult {
  const issues = new Issues();
  try {
    const root = objectView(
      input,
      "$",
      ["version", "metrics", "dimensions", "filters", "orderBy", "limit"],
      ["version", "metrics"],
      issues,
    );
    if (!root) return failure(issues);

    if (
      typeof root.values.version !== "number" ||
      !Number.isInteger(root.values.version)
    )
      issues.add("$.version", "INVALID_TYPE");
    else if (root.values.version !== 1)
      issues.add("$.version", "UNSUPPORTED_VERSION");

    const metrics = keyedArray(
      root.values.metrics,
      "$.metrics",
      1,
      MAX_QUERY_METRICS,
      issues,
    );
    const dimensions = root.keys.has("dimensions")
      ? keyedArray(
          root.values.dimensions,
          "$.dimensions",
          0,
          MAX_QUERY_DIMENSIONS,
          issues,
        )
      : undefined;
    const parsedFilters = root.keys.has("filters")
      ? filters(root.values.filters, "$.filters", issues)
      : undefined;
    const parsedOrder = root.keys.has("orderBy")
      ? orderBy(root.values.orderBy, "$.orderBy", issues)
      : undefined;

    let limit: number | undefined;
    if (root.keys.has("limit")) {
      const candidate = root.values.limit;
      if (
        typeof candidate !== "number" ||
        !Number.isSafeInteger(candidate) ||
        candidate < 1 ||
        candidate > 1000
      )
        issues.add("$.limit", "INVALID_LIMIT");
      else limit = candidate;
    }
    if (issues.values.length) return failure(issues);

    const query: SemanticQueryV1 = {
      version: 1,
      metrics: metrics!,
      ...(dimensions?.length ? { dimensions } : {}),
      ...(parsedFilters?.length ? { filters: parsedFilters } : {}),
      ...(parsedOrder?.length ? { orderBy: parsedOrder } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
    const canonicalJson = JSON.stringify(query);
    const canonicalBytes = new TextEncoder().encode(canonicalJson).byteLength;
    if (canonicalBytes > MAX_SEMANTIC_QUERY_BYTES) {
      issues.add("$", "QUERY_TOO_LARGE");
      return failure(issues);
    }
    return deepFreeze({ valid: true, query, canonicalJson, canonicalBytes });
  } catch {
    if (!issues.values.length) issues.add("$", "INVALID_TYPE");
    return failure(issues);
  }
}
