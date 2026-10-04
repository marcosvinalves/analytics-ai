import type { SemanticType } from "../../semantic/domain/semantic-field.ts";
import type {
  CompilationFailureCode,
  CompiledParameter,
  CompiledQuery,
  CompiledStatement,
  CompiledValidationCommand,
  CompilePhysicalQueryResult,
} from "../domain/compiled-query.ts";
import type {
  OutputDescriptor,
  PhysicalExpression,
  PhysicalLiteral,
  PhysicalQueryPlan,
  PhysicalValueType,
  PlannedSourceField,
} from "../domain/physical-query-plan.ts";

const SOURCE_TABLE = "__t018_source";
const INTEGER_PATTERN = "^-?[0-9]+$";
const DECIMAL_PATTERN = "^[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)$";
const NUMBER_PATTERN =
  "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$";
const DATE_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";
const DATETIME_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?$";
const INSTANT_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,6})?Z$";
const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const INTEGER_LITERAL_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;
const DECIMAL_LITERAL_PATTERN = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;
const NUMBER_LITERAL_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e-?(?:0|[1-9][0-9]*))?$/;

const CSV_OPTIONS = `delim=',', quote='"', escape='"', comment='', encoding='utf-8',
  compression='none', nullstr='', allow_quoted_nulls=true, ignore_errors=false,
  strict_mode=true, null_padding=false`;

class CompilationFailure {
  readonly result: Exclude<CompilePhysicalQueryResult, { outcome: "COMPILED" }>;

  constructor(
    result: Exclude<CompilePhysicalQueryResult, { outcome: "COMPILED" }>,
  ) {
    this.result = result;
  }
}

class Parameters {
  readonly values: CompiledParameter[] = [];

  material(): string {
    this.values.push({ kind: "MATERIAL_PATH" });
    return `$${this.values.length}`;
  }

  varchar(value: string): string {
    this.values.push({ kind: "VARCHAR", value });
    return `$${this.values.length}`;
  }

  boolean(value: boolean): string {
    this.values.push({ kind: "BOOLEAN", value });
    return `$${this.values.length}`;
  }
}

type ValidationCheck = {
  condition: string;
  failureCode: Extract<
    CompilationFailureCode,
    "SOURCE_VALUE_INVALID" | "NUMERIC_OVERFLOW"
  >;
};

function inconsistent(path: string): never {
  throw new CompilationFailure({
    outcome: "INCONSISTENT_PHYSICAL_PLAN",
    path,
  });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function samePhysicalType(
  left: PhysicalValueType,
  right: PhysicalValueType,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "DECIMAL" ||
      (right.kind === "DECIMAL" &&
        left.precision === right.precision &&
        left.scale === right.scale))
  );
}

function typeSql(type: PhysicalValueType): string {
  if (type.kind !== "DECIMAL") return type.kind;
  if (
    !Number.isInteger(type.precision) ||
    !Number.isInteger(type.scale) ||
    type.precision < 1 ||
    type.precision > 38 ||
    type.scale < 0 ||
    type.scale > type.precision
  )
    inconsistent("$.physicalType");
  return `DECIMAL(${type.precision},${type.scale})`;
}

function statement(
  sql: string,
  parameters: Parameters,
  engineErrorMappings: CompiledStatement["engineErrorMappings"] = [],
): CompiledStatement {
  return { sql, parameters: parameters.values, engineErrorMappings };
}

function csvColumns(count: number, prefix: "c" | "h"): string {
  return Array.from(
    { length: count },
    (_, index) => `'${prefix}${index}':'VARCHAR'`,
  ).join(",");
}

function csvReader(
  pathParameter: string,
  columnCount: number,
  prefix: "c" | "h",
  skip: 0 | 1,
): string {
  return `read_csv(${pathParameter}, auto_detect=false, header=false, skip=${skip}, columns={${csvColumns(columnCount, prefix)}}, ${CSV_OPTIONS})`;
}

function sourceHeaderValidation(
  plan: PhysicalQueryPlan,
): CompiledValidationCommand {
  const parameters = new Parameters();
  const path = parameters.material();
  const digits = String(plan.source.columns.length - 1).length;
  const cells = plan.source.columns
    .map((column, index) => {
      const expected = parameters.varchar(column.physicalName);
      const fallback = parameters.varchar(
        `column${String(index).padStart(digits, "0")}`,
      );
      return `SELECT ${quoteIdentifier(`h${index}`)} AS raw_name, ${expected} AS expected_name, ${fallback} AS fallback_name FROM header`;
    })
    .join(" UNION ALL ");
  const sql = `WITH header AS (
    SELECT ${plan.source.columns.map((_, index) => quoteIdentifier(`h${index}`)).join(",")}
    FROM ${csvReader(path, plan.source.columns.length, "h", 0)} LIMIT 1
  ), cells AS (${cells}), normalized AS (
    SELECT coalesce(nullif(trim(raw_name), ''), fallback_name) AS actual_name, expected_name FROM cells
  )
  SELECT count(*) = ${plan.source.columns.length}
    AND coalesce(bool_and(actual_name = expected_name), false)
    AND count(DISTINCT lower(actual_name)) = ${plan.source.columns.length} AS valid
  FROM normalized`;
  return {
    kind: "SOURCE_SCHEMA",
    purpose: "VALIDATE_CSV_HEADER",
    statement: statement(sql, parameters, [
      {
        exceptionType: "Invalid Input",
        failureCode: "SOURCE_SCHEMA_MISMATCH",
      },
    ]),
    result: {
      kind: "BOOLEAN",
      resultAlias: "valid",
      failureCode: "SOURCE_SCHEMA_MISMATCH",
    },
  };
}

function sourcePreparation(
  plan: PhysicalQueryPlan,
): CompiledQuery["preparation"] {
  const parameters = new Parameters();
  const path = parameters.material();
  const projection = plan.source.columns
    .map(
      (column, index) =>
        `${quoteIdentifier(`c${index}`)} AS ${quoteIdentifier(column.physicalName)}`,
    )
    .join(",");
  return {
    kind: "SOURCE_MATERIALIZATION",
    purpose: "MATERIALIZE_CSV_AS_TEXT",
    statement: statement(
      `CREATE TEMP TABLE ${quoteIdentifier(SOURCE_TABLE)} AS SELECT ${projection} FROM ${csvReader(path, plan.source.columns.length, "c", 1)}`,
      parameters,
      [
        {
          exceptionType: "Invalid Input",
          failureCode: "SOURCE_SCHEMA_MISMATCH",
        },
      ],
    ),
  };
}

function rowCountValidation(
  plan: PhysicalQueryPlan,
): CompiledValidationCommand {
  const parameters = new Parameters();
  const expected = parameters.varchar(plan.source.expectedRowCount.toString());
  return {
    kind: "SOURCE_ROW_COUNT",
    purpose: "VALIDATE_EXPECTED_ROW_COUNT",
    statement: statement(
      `SELECT count(*) = CAST(${expected} AS HUGEINT) AS valid FROM ${quoteIdentifier(SOURCE_TABLE)}`,
      parameters,
    ),
    result: {
      kind: "BOOLEAN",
      resultAlias: "valid",
      failureCode: "SOURCE_SCHEMA_MISMATCH",
    },
  };
}

function decimalChecks(
  expression: string,
  precision: number,
  scale: number,
): ValidationCheck[] {
  const unsigned = `ltrim(${expression}, '+-')`;
  const fraction = `split_part(${unsigned}, '.', 2)`;
  const integer = `split_part(${unsigned}, '.', 1)`;
  const lexical = `regexp_full_match(${expression}, '${DECIMAL_PATTERN}')`;
  const scaleInvalid = `length(${fraction}) > ${scale}`;
  const overflow = `length(ltrim(${integer}, '0')) > ${precision - scale} OR try_cast(${expression} AS DECIMAL(${precision},${scale})) IS NULL`;
  return [
    {
      condition: `NOT ${lexical} OR (${lexical} AND ${scaleInvalid})`,
      failureCode: "SOURCE_VALUE_INVALID",
    },
    {
      condition: `${lexical} AND NOT (${scaleInvalid}) AND (${overflow})`,
      failureCode: "NUMERIC_OVERFLOW",
    },
  ];
}

function conversionChecks(
  expression: string,
  field: PlannedSourceField,
): ValidationCheck[] {
  const conversion = field.conversion;
  switch (conversion.kind) {
    case "TEXT_IDENTITY":
      return [
        {
          condition: `contains(${expression}, chr(0))`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    case "TEXT_TO_BOOLEAN":
      return [
        {
          condition: `${expression} NOT IN ('true','false')`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    case "TEXT_TO_EXACT_INTEGER": {
      const lexical = `regexp_full_match(${expression}, '${INTEGER_PATTERN}')`;
      return [
        {
          condition: `NOT ${lexical}`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
        {
          condition: `${lexical} AND try_cast(${expression} AS HUGEINT) IS NULL`,
          failureCode: "NUMERIC_OVERFLOW",
        },
      ];
    }
    case "TEXT_TO_EXACT_DECIMAL":
      return decimalChecks(expression, conversion.precision, conversion.scale);
    case "TEXT_TO_FINITE_DOUBLE": {
      const lexical = `regexp_full_match(${expression}, '${NUMBER_PATTERN}')`;
      const converted = `try_cast(${expression} AS DOUBLE)`;
      const nonzero = `regexp_matches(split_part(lower(ltrim(${expression}, '+-')), 'e', 1), '[1-9]')`;
      return [
        {
          condition: `NOT ${lexical}`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
        {
          condition: `${lexical} AND (${converted} IS NULL OR NOT isfinite(${converted}) OR (${nonzero} AND ${converted} = 0))`,
          failureCode: "NUMERIC_OVERFLOW",
        },
      ];
    }
    case "TEXT_TO_DATE": {
      const lexical = `regexp_full_match(${expression}, '${DATE_PATTERN}')`;
      return [
        {
          condition: `NOT ${lexical} OR (${lexical} AND try_cast(${expression} AS DATE) IS NULL)`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    }
    case "TEXT_TO_DATETIME": {
      const lexical = `regexp_full_match(${expression}, '${DATETIME_PATTERN}')`;
      const parsed = `try_strptime(${expression}, ['%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S'])`;
      return [
        {
          condition: `NOT ${lexical} OR (${lexical} AND ${parsed} IS NULL)`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    }
    case "TEXT_TO_INSTANT": {
      const lexical = `regexp_full_match(${expression}, '${INSTANT_PATTERN}')`;
      return [
        {
          condition: `NOT ${lexical} OR (${lexical} AND try_cast(${expression} AS TIMESTAMPTZ) IS NULL)`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    }
    case "UUID_TEXT": {
      const lexical = `regexp_full_match(lower(${expression}), '${UUID_PATTERN}')`;
      return [
        {
          condition: `NOT ${lexical} OR (${lexical} AND try_cast(${expression} AS UUID) IS NULL)`,
          failureCode: "SOURCE_VALUE_INVALID",
        },
      ];
    }
  }
}

function sourceValueValidation(
  plan: PhysicalQueryPlan,
): CompiledValidationCommand | undefined {
  const selects: string[] = [];
  const checks: Extract<
    CompiledValidationCommand["result"],
    { kind: "VIOLATION_COUNTS" }
  >["checks"][number][] = [];
  for (
    let fieldIndex = 0;
    fieldIndex < plan.sourceFields.length;
    fieldIndex += 1
  ) {
    const field = plan.sourceFields[fieldIndex];
    const column = plan.source.columns[field.columnIndex];
    if (!column) inconsistent(`$.sourceFields[${fieldIndex}].columnIndex`);
    const quoted = quoteIdentifier(column.physicalName);
    for (const check of conversionChecks(quoted, field)) {
      const resultAlias = `v${checks.length}`;
      selects.push(
        `count(*) FILTER (WHERE ${quoted} IS NOT NULL AND (${check.condition})) AS ${quoteIdentifier(resultAlias)}`,
      );
      checks.push({
        resultAlias,
        failureCode: check.failureCode,
        sourceFieldIndex: fieldIndex,
      });
    }
  }
  if (checks.length === 0) return undefined;
  return {
    kind: "SOURCE_VALUE",
    purpose: "VALIDATE_USED_SOURCE_FIELDS",
    statement: statement(
      `SELECT ${selects.join(",")} FROM ${quoteIdentifier(SOURCE_TABLE)}`,
      new Parameters(),
    ),
    result: { kind: "VIOLATION_COUNTS", checks },
  };
}

function sourceSql(plan: PhysicalQueryPlan, sourceFieldIndex: number): string {
  const field = plan.sourceFields[sourceFieldIndex];
  if (!field) inconsistent("$.expression.sourceFieldIndex");
  const column = plan.source.columns[field.columnIndex];
  if (!column) inconsistent("$.sourceFields.columnIndex");
  const value = quoteIdentifier(column.physicalName);
  switch (field.conversion.kind) {
    case "TEXT_IDENTITY":
    case "UUID_TEXT":
      return value;
    case "TEXT_TO_BOOLEAN":
      return `CASE ${value} WHEN 'true' THEN true WHEN 'false' THEN false ELSE NULL END`;
    case "TEXT_TO_EXACT_INTEGER":
      return `CAST(${value} AS HUGEINT)`;
    case "TEXT_TO_EXACT_DECIMAL":
      return `CAST(${value} AS DECIMAL(${field.conversion.precision},${field.conversion.scale}))`;
    case "TEXT_TO_FINITE_DOUBLE":
      return `CAST(${value} AS DOUBLE)`;
    case "TEXT_TO_DATE":
      return `CAST(${value} AS DATE)`;
    case "TEXT_TO_DATETIME":
      return `strptime(${value}, ['%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S'])`;
    case "TEXT_TO_INSTANT":
      return `CAST(${value} AS TIMESTAMPTZ)`;
  }
}

function validateLiteral(literal: PhysicalLiteral): void {
  const type = literal.literalType;
  const value = literal.value;
  const expectedKind =
    type.kind === "STRING"
      ? "TEXT"
      : type.kind === "INTEGER"
        ? "HUGEINT"
        : type.kind === "NUMBER"
          ? "DOUBLE"
          : type.kind === "DATETIME"
            ? "TIMESTAMP"
            : type.kind === "INSTANT"
              ? "TIMESTAMPTZ"
              : type.kind;
  if (literal.resultType.kind !== expectedKind)
    inconsistent("$.literal.resultType");
  if (
    type.kind === "DECIMAL" &&
    (literal.resultType.kind !== "DECIMAL" ||
      literal.resultType.precision !== type.precision ||
      literal.resultType.scale !== type.scale)
  )
    inconsistent("$.literal.resultType");
  if (type.kind === "BOOLEAN") {
    if (typeof value !== "boolean") inconsistent("$.literal.value");
    return;
  }
  if (typeof value !== "string") inconsistent("$.literal.value");
  if (type.kind === "STRING") {
    if (value.includes("\0")) inconsistent("$.literal.value");
    return;
  }
  if (
    type.kind === "INTEGER" &&
    (!INTEGER_LITERAL_PATTERN.test(value) ||
      value === "-0" ||
      value.replace("-", "").length > 38)
  )
    inconsistent("$.literal.value");
  if (type.kind === "DECIMAL") {
    if (!DECIMAL_LITERAL_PATTERN.test(value) || /^-0\.0+$/.test(value))
      inconsistent("$.literal.value");
    const [integer, fraction] = value.replace("-", "").split(".");
    const precision = (integer === "0" ? 0 : integer.length) + fraction.length;
    if (Math.max(1, precision) > type.precision || fraction.length > type.scale)
      inconsistent("$.literal.value");
  }
  if (
    type.kind === "NUMBER" &&
    (!NUMBER_LITERAL_PATTERN.test(value) ||
      value.length > 64 ||
      /^-0(?:\.0+)?(?:e-?(?:0|[1-9][0-9]*))?$/.test(value))
  )
    inconsistent("$.literal.value");
  if (type.kind === "DATE" && !new RegExp(DATE_PATTERN).test(value))
    inconsistent("$.literal.value");
  if (type.kind === "DATETIME" && !new RegExp(DATETIME_PATTERN).test(value))
    inconsistent("$.literal.value");
  if (type.kind === "INSTANT" && !new RegExp(INSTANT_PATTERN).test(value))
    inconsistent("$.literal.value");
}

function literalSql(literal: PhysicalLiteral, parameters: Parameters): string {
  validateLiteral(literal);
  const parameter =
    literal.literalType.kind === "BOOLEAN"
      ? parameters.boolean(literal.value as boolean)
      : parameters.varchar(literal.value as string);
  switch (literal.resultType.kind) {
    case "TEXT":
      return parameter;
    case "BOOLEAN":
      return parameter;
    case "HUGEINT":
      return `CAST(${parameter} AS HUGEINT)`;
    case "DOUBLE":
      return `CAST(${parameter} AS DOUBLE)`;
    case "DATE":
      return `CAST(${parameter} AS DATE)`;
    case "TIMESTAMP":
      return `strptime(${parameter}, ['%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S'])`;
    case "TIMESTAMPTZ":
      return `CAST(${parameter} AS TIMESTAMPTZ)`;
    case "DECIMAL":
      return `CAST(${parameter} AS ${typeSql(literal.resultType)})`;
    case "BIGINT":
      inconsistent("$.literal.resultType");
  }
}

function compileExpression(
  plan: PhysicalQueryPlan,
  expression: PhysicalExpression,
  parameters: Parameters,
): string {
  if (expression.kind === "SOURCE_FIELD") {
    const field = plan.sourceFields[expression.sourceFieldIndex];
    if (!field || !samePhysicalType(field.resultType, expression.resultType))
      inconsistent("$.expression.sourceFieldIndex");
    return sourceSql(plan, expression.sourceFieldIndex);
  }
  if (expression.kind === "LITERAL") return literalSql(expression, parameters);
  if (expression.kind === "AGGREGATE") {
    const inner = compileExpression(plan, expression.expression, parameters);
    if (expression.op === "COUNT") return `count(${inner})`;
    if (expression.op === "COUNT_DISTINCT") return `count(DISTINCT ${inner})`;
    const aggregate = `sum(${inner})`;
    return expression.resultType.kind === "DECIMAL"
      ? `CAST(${aggregate} AS ${typeSql(expression.resultType)})`
      : aggregate;
  }

  const left = compileExpression(plan, expression.left, parameters);
  const right = compileExpression(plan, expression.right, parameters);
  const operator =
    expression.op === "ADD" ? "+" : expression.op === "SUBTRACT" ? "-" : "*";
  if (expression.arithmeticPolicy === "EXACT_INTEGER") {
    if (
      expression.resultType.kind !== "HUGEINT" ||
      expression.left.resultType.kind !== "HUGEINT" ||
      expression.right.resultType.kind !== "HUGEINT"
    )
      inconsistent("$.expression.arithmeticPolicy");
    return `(${left} ${operator} ${right})`;
  }
  if (expression.arithmeticPolicy === "APPROXIMATE_DOUBLE") {
    if (expression.resultType.kind !== "DOUBLE")
      inconsistent("$.expression.arithmeticPolicy");
    return `CAST((${left} ${operator} ${right}) AS DOUBLE)`;
  }
  if (expression.resultType.kind !== "DECIMAL")
    inconsistent("$.expression.arithmeticPolicy");

  const target = typeSql(expression.resultType);
  const decimalOperand = (sql: string, type: PhysicalValueType) => {
    if (type.kind !== "DECIMAL") return sql;
    if (expression.resultType.kind !== "DECIMAL") return sql;
    if (type.precision > expression.resultType.precision)
      inconsistent("$.expression.resultType");
    return `CAST(${sql} AS DECIMAL(${expression.resultType.precision},${type.scale}))`;
  };
  return `CAST((${decimalOperand(left, expression.left.resultType)} ${operator} ${decimalOperand(right, expression.right.resultType)}) AS ${target})`;
}

function collectLiterals(
  expression: PhysicalExpression,
  into: PhysicalLiteral[],
) {
  if (expression.kind === "LITERAL") into.push(expression);
  else if (expression.kind === "BINARY") {
    collectLiterals(expression.left, into);
    collectLiterals(expression.right, into);
  } else if (expression.kind === "AGGREGATE")
    collectLiterals(expression.expression, into);
}

function literalValidation(
  plan: PhysicalQueryPlan,
): CompiledValidationCommand | undefined {
  const literals: PhysicalLiteral[] = [];
  for (const metric of plan.metrics)
    collectLiterals(metric.expression, literals);
  for (const filter of plan.filters) {
    if (filter.op === "IN") literals.push(...filter.values);
    else if ("value" in filter) literals.push(filter.value);
  }
  const parameters = new Parameters();
  const selects: string[] = [];
  const checks: Extract<
    CompiledValidationCommand["result"],
    { kind: "VIOLATION_COUNTS" }
  >["checks"][number][] = [];
  for (const literal of literals) {
    if (literal.literalType.kind === "BOOLEAN") continue;
    const value = parameters.varchar(literal.value as string);
    let conditions: ValidationCheck[] = [];
    switch (literal.resultType.kind) {
      case "TEXT":
        conditions = [
          {
            condition: `contains(${value}, chr(0))`,
            failureCode: "SOURCE_VALUE_INVALID",
          },
        ];
        break;
      case "HUGEINT":
        conditions = [
          {
            condition: `try_cast(${value} AS HUGEINT) IS NULL`,
            failureCode: "NUMERIC_OVERFLOW",
          },
        ];
        break;
      case "DOUBLE":
        conditions = [
          {
            condition: `try_cast(${value} AS DOUBLE) IS NULL OR NOT isfinite(try_cast(${value} AS DOUBLE)) OR (regexp_matches(split_part(lower(ltrim(${value}, '+-')), 'e', 1), '[1-9]') AND try_cast(${value} AS DOUBLE) = 0)`,
            failureCode: "NUMERIC_OVERFLOW",
          },
        ];
        break;
      case "DECIMAL":
        conditions = decimalChecks(
          value,
          literal.resultType.precision,
          literal.resultType.scale,
        );
        break;
      case "DATE":
        conditions = [
          {
            condition: `try_cast(${value} AS DATE) IS NULL`,
            failureCode: "SOURCE_VALUE_INVALID",
          },
        ];
        break;
      case "TIMESTAMP":
        conditions = [
          {
            condition: `try_strptime(${value}, ['%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S']) IS NULL`,
            failureCode: "SOURCE_VALUE_INVALID",
          },
        ];
        break;
      case "TIMESTAMPTZ":
        conditions = [
          {
            condition: `try_cast(${value} AS TIMESTAMPTZ) IS NULL`,
            failureCode: "SOURCE_VALUE_INVALID",
          },
        ];
        break;
      case "BOOLEAN":
      case "BIGINT":
        break;
    }
    for (const condition of conditions) {
      const resultAlias = `v${checks.length}`;
      selects.push(
        `CASE WHEN ${condition.condition} THEN 1 ELSE 0 END AS ${quoteIdentifier(resultAlias)}`,
      );
      checks.push({ resultAlias, failureCode: condition.failureCode });
    }
  }
  if (checks.length === 0) return undefined;
  return {
    kind: "LITERAL_CAPABILITY",
    purpose: "VALIDATE_LITERAL_ENGINE_CAPABILITY",
    statement: statement(`SELECT ${selects.join(",")}`, parameters),
    result: { kind: "VIOLATION_COUNTS", checks },
  };
}

function analyticalStatement(plan: PhysicalQueryPlan): CompiledStatement {
  const parameters = new Parameters();
  const select = [
    ...plan.dimensions.map(
      (dimension) =>
        `${compileExpression(plan, dimension.expression, parameters)} AS ${quoteIdentifier(`o${dimension.outputIndex}`)}`,
    ),
    ...plan.metrics.map(
      (metric) =>
        `${compileExpression(plan, metric.expression, parameters)} AS ${quoteIdentifier(`o${metric.outputIndex}`)}`,
    ),
  ];
  const filters = plan.filters.map((filter) => {
    const field = compileExpression(plan, filter.field, parameters);
    if (filter.op === "IS_NULL") return `${field} IS NULL`;
    if (filter.op === "IS_NOT_NULL") return `${field} IS NOT NULL`;
    if (filter.op === "IN")
      return `${field} IN (${filter.values.map((value) => literalSql(value, parameters)).join(",")})`;
    if (!("value" in filter)) inconsistent("$.filters");
    const operator = {
      EQ: "=",
      NEQ: "<>",
      GT: ">",
      GTE: ">=",
      LT: "<",
      LTE: "<=",
    }[filter.op];
    return `${field} ${operator} ${literalSql(filter.value, parameters)}`;
  });
  const group =
    plan.dimensions.length === 0
      ? ""
      : ` GROUP BY ${plan.dimensions.map((_, index) => index + 1).join(",")}`;
  const order =
    plan.orderBy.length === 0
      ? ""
      : ` ORDER BY ${plan.orderBy.map((item) => `${item.outputIndex + 1} ${item.direction} NULLS LAST`).join(",")}`;
  const limit =
    plan.semanticLimit === undefined ? "" : ` LIMIT ${plan.semanticLimit}`;
  return statement(
    `SELECT ${select.join(",")} FROM ${quoteIdentifier(SOURCE_TABLE)}${filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`}${group}${order}${limit}`,
    parameters,
    [
      {
        exceptionType: "Out of Range",
        failureCode: "NUMERIC_OVERFLOW",
      },
    ],
  );
}

function resultValueValidation(
  plan: PhysicalQueryPlan,
): CompiledValidationCommand | undefined {
  const outputs = plan.output.filter(
    (item) => item.physicalType.kind === "DOUBLE",
  );
  if (outputs.length === 0) return undefined;
  const analytical = analyticalStatement(plan);
  const checks = outputs.map((output, index) => ({
    resultAlias: `v${index}`,
    failureCode: "NUMERIC_OVERFLOW" as const,
    outputIndex: output.outputIndex,
  }));
  return {
    kind: "RESULT_VALUE",
    purpose: "VALIDATE_FINITE_DOUBLE_RESULTS",
    statement: {
      sql: `WITH ${quoteIdentifier("__t018_result")} AS (${analytical.sql}) SELECT ${outputs
        .map(
          (output, index) =>
            `count(*) FILTER (WHERE ${quoteIdentifier(`o${output.outputIndex}`)} IS NOT NULL AND NOT isfinite(${quoteIdentifier(`o${output.outputIndex}`)})) AS ${quoteIdentifier(`v${index}`)}`,
        )
        .join(",")} FROM ${quoteIdentifier("__t018_result")}`,
      parameters: analytical.parameters,
      engineErrorMappings: analytical.engineErrorMappings,
    },
    result: { kind: "VIOLATION_COUNTS", checks },
  };
}

function cloneSemanticType(type: SemanticType): SemanticType {
  return type.kind === "DECIMAL"
    ? { kind: "DECIMAL", precision: type.precision, scale: type.scale }
    : { kind: type.kind };
}

function cloneOutput(output: OutputDescriptor): OutputDescriptor {
  return {
    outputIndex: output.outputIndex,
    role: output.role,
    semanticKey:
      output.semanticKey.kind === "FIELD"
        ? { kind: "FIELD", fieldKey: output.semanticKey.fieldKey }
        : { kind: "METRIC", metricKey: output.semanticKey.metricKey },
    name: output.name,
    label: output.label,
    semanticType: cloneSemanticType(output.semanticType),
    physicalType:
      output.physicalType.kind === "DECIMAL"
        ? {
            kind: "DECIMAL",
            precision: output.physicalType.precision,
            scale: output.physicalType.scale,
          }
        : { kind: output.physicalType.kind },
  };
}

function validatePlan(plan: PhysicalQueryPlan): void {
  if (
    plan.version !== 1 ||
    plan.source.kind !== "CSV" ||
    plan.source.readMode !== "TEXT" ||
    plan.source.columns.length === 0 ||
    plan.source.expectedSizeBytes <= BigInt(0) ||
    plan.source.expectedRowCount < BigInt(0) ||
    plan.source.schemaValidation.expectedRowCount !==
      plan.source.expectedRowCount ||
    plan.source.dialect.encoding !== "UTF-8" ||
    plan.source.dialect.delimiter !== "," ||
    plan.source.dialect.quote !== '"' ||
    plan.source.dialect.escape !== '"' ||
    !plan.source.dialect.header ||
    !plan.source.dialect.strict
  )
    inconsistent("$.source");
  const names = new Set<string>();
  plan.source.columns.forEach((column, index) => {
    const normalized = column.physicalName.toLowerCase();
    if (
      column.ordinalPosition !== index + 1 ||
      !column.physicalName.trim() ||
      column.physicalName.includes("\0") ||
      names.has(normalized)
    )
      inconsistent(`$.source.columns[${index}]`);
    names.add(normalized);
  });
  plan.sourceFields.forEach((field, index) => {
    if (
      !Number.isInteger(field.columnIndex) ||
      field.columnIndex < 0 ||
      field.columnIndex >= plan.source.columns.length
    )
      inconsistent(`$.sourceFields[${index}].columnIndex`);
    typeSql(field.resultType);
    const expected =
      field.conversion.kind === "TEXT_IDENTITY" ||
      field.conversion.kind === "UUID_TEXT"
        ? "TEXT"
        : field.conversion.kind === "TEXT_TO_BOOLEAN"
          ? "BOOLEAN"
          : field.conversion.kind === "TEXT_TO_EXACT_INTEGER"
            ? "HUGEINT"
            : field.conversion.kind === "TEXT_TO_FINITE_DOUBLE"
              ? "DOUBLE"
              : field.conversion.kind === "TEXT_TO_DATE"
                ? "DATE"
                : field.conversion.kind === "TEXT_TO_DATETIME"
                  ? "TIMESTAMP"
                  : field.conversion.kind === "TEXT_TO_INSTANT"
                    ? "TIMESTAMPTZ"
                    : "DECIMAL";
    if (field.resultType.kind !== expected)
      inconsistent(`$.sourceFields[${index}].resultType`);
    if (
      field.conversion.kind === "TEXT_TO_EXACT_DECIMAL" &&
      (field.resultType.kind !== "DECIMAL" ||
        field.conversion.precision !== field.resultType.precision ||
        field.conversion.scale !== field.resultType.scale)
    )
      inconsistent(`$.sourceFields[${index}].resultType`);
  });
  if (plan.output.length !== plan.dimensions.length + plan.metrics.length)
    inconsistent("$.output");
  plan.output.forEach((output, index) => {
    if (output.outputIndex !== index) inconsistent(`$.output[${index}]`);
    typeSql(output.physicalType);
  });
  plan.dimensions.forEach((dimension, index) => {
    if (dimension.outputIndex !== index)
      inconsistent(`$.dimensions[${index}].outputIndex`);
    if (
      !samePhysicalType(
        dimension.expression.resultType,
        plan.output[index].physicalType,
      )
    )
      inconsistent(`$.dimensions[${index}].expression`);
  });
  plan.metrics.forEach((metric, index) => {
    if (metric.outputIndex !== plan.dimensions.length + index)
      inconsistent(`$.metrics[${index}].outputIndex`);
    if (
      !samePhysicalType(
        metric.expression.resultType,
        plan.output[metric.outputIndex].physicalType,
      )
    )
      inconsistent(`$.metrics[${index}].expression`);
  });
  plan.orderBy.forEach((order, index) => {
    if (
      !Number.isInteger(order.outputIndex) ||
      order.outputIndex < 0 ||
      order.outputIndex >= plan.output.length ||
      !["ASC", "DESC"].includes(order.direction) ||
      order.nulls !== "LAST"
    )
      inconsistent(`$.orderBy[${index}]`);
  });
  if (
    plan.semanticLimit !== undefined &&
    (!Number.isInteger(plan.semanticLimit) ||
      plan.semanticLimit < 1 ||
      plan.semanticLimit > 1000)
  )
    inconsistent("$.semanticLimit");
}

export function compilePhysicalQuery(
  plan: PhysicalQueryPlan,
): CompilePhysicalQueryResult {
  try {
    validatePlan(plan);
    const validations: CompiledValidationCommand[] = [rowCountValidation(plan)];
    const sourceValues = sourceValueValidation(plan);
    if (sourceValues) validations.push(sourceValues);
    const literals = literalValidation(plan);
    if (literals) validations.push(literals);
    const resultValues = resultValueValidation(plan);
    if (resultValues) validations.push(resultValues);
    return deepFreeze({
      outcome: "COMPILED",
      compiledQuery: {
        version: 1,
        material: plan.source.material,
        sessionRequirements: { timeZone: "UTC" },
        lifecycle: {
          connection: "DEDICATED_PER_EXECUTION",
          temporaryObject: SOURCE_TABLE,
          cleanup: "CLOSE_CONNECTION",
        },
        sourceValidations: [sourceHeaderValidation(plan)],
        preparation: sourcePreparation(plan),
        validations,
        query: analyticalStatement(plan),
        outputs: plan.output.map(cloneOutput),
      },
    });
  } catch (error) {
    return error instanceof CompilationFailure
      ? error.result
      : { outcome: "INCONSISTENT_PHYSICAL_PLAN", path: "$" };
  }
}
