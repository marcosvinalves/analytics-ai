import { expect, test } from "vitest";
import type { AnalyticalMaterialHandle } from "../../src/modules/dataset/domain/analytical-source.ts";
import type {
  PhysicalQueryPlan,
  PlannedSourceField,
  SourceConversionPolicy,
} from "../../src/modules/query/domain/physical-query-plan.ts";
import { compilePhysicalQuery } from "../../src/modules/query/infrastructure/duckdb-query-compiler.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const material = Object.freeze({}) as AnalyticalMaterialHandle;

function sourceField(
  columnIndex: number,
  conversion: SourceConversionPolicy,
  resultType: PlannedSourceField["resultType"],
): PlannedSourceField {
  let semanticType: SemanticType;
  switch (resultType.kind) {
    case "TEXT":
      semanticType = { kind: "STRING" };
      break;
    case "HUGEINT":
    case "BIGINT":
      semanticType = { kind: "INTEGER" };
      break;
    case "DOUBLE":
      semanticType = { kind: "NUMBER" };
      break;
    case "TIMESTAMP":
      semanticType = { kind: "DATETIME" };
      break;
    case "TIMESTAMPTZ":
      semanticType = { kind: "INSTANT" };
      break;
    case "DECIMAL":
      semanticType = {
        kind: "DECIMAL",
        precision: resultType.precision,
        scale: resultType.scale,
      };
      break;
    case "BOOLEAN":
      semanticType = { kind: "BOOLEAN" };
      break;
    case "DATE":
      semanticType = { kind: "DATE" };
  }
  return {
    fieldKey: `field-${columnIndex}`,
    columnIndex,
    semanticType,
    persistedPhysicalType:
      resultType.kind === "DECIMAL"
        ? {
            family: "DECIMAL",
            name: `DECIMAL(${resultType.precision},${resultType.scale})`,
            precision: resultType.precision,
            scale: resultType.scale,
          }
        : resultType.kind === "HUGEINT"
          ? {
              family: "INTEGER",
              name: "BIGINT",
              decimalDigits: 19,
            }
          : resultType.kind === "DOUBLE"
            ? { family: "NUMBER", name: "DOUBLE" }
            : resultType.kind === "BOOLEAN"
              ? { family: "BOOLEAN", name: "BOOLEAN" }
              : resultType.kind === "DATE"
                ? { family: "DATE", name: "DATE" }
                : resultType.kind === "TIMESTAMP"
                  ? { family: "DATETIME", name: "TIMESTAMP" }
                  : resultType.kind === "TIMESTAMPTZ"
                    ? {
                        family: "INSTANT",
                        name: "TIMESTAMP WITH TIME ZONE",
                      }
                    : { family: "STRING", name: "VARCHAR" },
    compatibility: "EXECUTABLE_SAFE",
    conversion,
    resultType,
  };
}

function plan(): PhysicalQueryPlan {
  const text = sourceField(
    0,
    {
      kind: "TEXT_IDENTITY",
      trim: false,
      normalizeUnicode: false,
      rejectNul: true,
      nulls: "PRESERVE",
    },
    { kind: "TEXT" },
  );
  const quantity = sourceField(
    1,
    {
      kind: "TEXT_TO_EXACT_INTEGER",
      fractionalValues: "ERROR",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
    { kind: "HUGEINT" },
  );
  const price = sourceField(
    2,
    {
      kind: "TEXT_TO_EXACT_DECIMAL",
      precision: 18,
      scale: 2,
      scientificNotation: "ERROR",
      rounding: "FORBIDDEN",
      truncation: "FORBIDDEN",
      overflow: "ERROR",
      nulls: "PRESERVE",
    },
    { kind: "DECIMAL", precision: 18, scale: 2 },
  );
  return {
    version: 1,
    context: {
      semanticModelId: "model",
      semanticModelRevisionId: "revision",
      datasetId: "dataset",
      datasetVersionId: "version",
    },
    source: {
      kind: "CSV",
      material,
      materialIdentity: {
        device: BigInt(1),
        inode: BigInt(2),
        sizeBytes: BigInt(100),
        modifiedTimeNs: BigInt(3),
      },
      expectedSizeBytes: BigInt(100),
      expectedRowCount: BigInt(3),
      columns: [
        { physicalName: 'select " 名', ordinalPosition: 1 },
        { physicalName: "quantity", ordinalPosition: 2 },
        { physicalName: "unit_price", ordinalPosition: 3 },
      ],
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
        expectedRowCount: BigInt(3),
      },
    },
    sourceFields: [text, quantity, price],
    dimensions: [
      {
        outputIndex: 0,
        expression: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 0,
          resultType: { kind: "TEXT" },
        },
        semanticType: { kind: "STRING" },
      },
    ],
    metrics: [
      {
        outputIndex: 1,
        semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
        expression: {
          kind: "AGGREGATE",
          op: "SUM",
          aggregationPolicy: "EXACT_DECIMAL",
          overflow: "ERROR",
          requireFiniteResult: false,
          resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
          expression: {
            kind: "BINARY",
            op: "MULTIPLY",
            arithmeticPolicy: "EXACT_DECIMAL",
            overflow: "ERROR",
            requireFiniteResult: false,
            resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
            left: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 1,
              resultType: { kind: "HUGEINT" },
            },
            right: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 2,
              resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
            },
          },
        },
      },
    ],
    filters: [
      {
        field: {
          kind: "SOURCE_FIELD",
          sourceFieldIndex: 0,
          resultType: { kind: "TEXT" },
        },
        op: "EQ",
        value: {
          kind: "LITERAL",
          literalType: { kind: "STRING" },
          value: "x'); DROP TABLE data; --",
          resultType: { kind: "TEXT" },
        },
      },
    ],
    orderBy: [
      { outputIndex: 0, direction: "ASC", nulls: "LAST" },
      { outputIndex: 1, direction: "DESC", nulls: "LAST" },
    ],
    semanticLimit: 25,
    output: [
      {
        outputIndex: 0,
        role: "DIMENSION",
        semanticKey: { kind: "FIELD", fieldKey: "city" },
        name: "city",
        label: "City",
        semanticType: { kind: "STRING" },
        physicalType: { kind: "TEXT" },
      },
      {
        outputIndex: 1,
        role: "METRIC",
        semanticKey: { kind: "METRIC", metricKey: "revenue" },
        name: "revenue",
        label: "Revenue",
        semanticType: { kind: "DECIMAL", precision: 38, scale: 2 },
        physicalType: { kind: "DECIMAL", precision: 38, scale: 2 },
      },
    ],
  };
}

function compiled(input = plan()) {
  const result = compilePhysicalQuery(input);
  if (result.outcome !== "COMPILED") throw new Error(result.outcome);
  return result.compiledQuery;
}

test("compiles a closed deterministic lifecycle with an opaque material", () => {
  const input = plan();
  const first = compiled(input);
  const second = compiled(input);
  expect(first).toEqual(second);
  expect(first.material).toBe(material);
  expect(first.lifecycle).toEqual({
    connection: "DEDICATED_PER_EXECUTION",
    temporaryObject: "__t018_source",
    cleanup: "CLOSE_CONNECTION",
  });
  expect(first.sessionRequirements).toEqual({ timeZone: "UTC" });
  expect(first.sourceValidations[0].statement.parameters[0]).toEqual({
    kind: "MATERIAL_PATH",
  });
  expect(first.preparation.statement.parameters).toEqual([
    { kind: "MATERIAL_PATH" },
  ]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.query.parameters)).toBe(true);
  expect(input).toEqual(plan());
});

test("quotes only identifiers and binds literals without leaking semantic metadata", () => {
  const result = compiled();
  expect(result.preparation.statement.sql).toContain('"c0" AS "select "" 名"');
  expect(result.query.sql).toContain('"select "" 名" AS "o0"');
  expect(result.query.sql).toContain("GROUP BY 1");
  expect(result.query.sql).toContain(
    "ORDER BY 1 ASC NULLS LAST,2 DESC NULLS LAST LIMIT 25",
  );
  expect(result.query.sql).not.toContain("DROP TABLE data");
  expect(result.query.sql).not.toContain("Revenue");
  expect(result.query.parameters).toContainEqual({
    kind: "VARCHAR",
    value: "x'); DROP TABLE data; --",
  });
  expect(result.query.engineErrorMappings).toEqual([
    { exceptionType: "Out of Range", failureCode: "NUMERIC_OVERFLOW" },
  ]);
});

test("compiles exact decimal validation before direct HUGEINT decimal arithmetic", () => {
  const result = compiled();
  const values = result.validations.find(
    (command) => command.kind === "SOURCE_VALUE",
  )!;
  expect(values.statement.sql).toContain("regexp_full_match");
  expect(values.statement.sql).toContain("length(split_part");
  expect(values.statement.sql).toContain("try_cast");
  expect(values.result.kind).toBe("VIOLATION_COUNTS");
  if (values.result.kind !== "VIOLATION_COUNTS") return;
  expect(values.result.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        failureCode: "SOURCE_VALUE_INVALID",
        sourceFieldIndex: 2,
      }),
      expect.objectContaining({
        failureCode: "NUMERIC_OVERFLOW",
        sourceFieldIndex: 2,
      }),
    ]),
  );
  expect(result.query.sql).toContain('CAST("quantity" AS HUGEINT)');
  expect(result.query.sql).toContain('CAST("unit_price" AS DECIMAL(18,2))');
  expect(result.query.sql).not.toContain("DOUBLE");
  expect(result.query.sql).not.toContain("ROUND");
});

test("compiles every source conversion policy into controlled checks", () => {
  const input = plan();
  const cases: Array<{
    name: string;
    field: PlannedSourceField;
  }> = [
    {
      name: "boolean",
      field: sourceField(
        0,
        {
          kind: "TEXT_TO_BOOLEAN",
          acceptedTokens: ["true", "false"],
          nulls: "PRESERVE",
        },
        { kind: "BOOLEAN" },
      ),
    },
    {
      name: "number",
      field: sourceField(
        0,
        {
          kind: "TEXT_TO_FINITE_DOUBLE",
          overflow: "ERROR",
          underflowToZero: "ERROR",
          nonFinite: "ERROR",
          nulls: "PRESERVE",
        },
        { kind: "DOUBLE" },
      ),
    },
    {
      name: "date",
      field: sourceField(
        0,
        { kind: "TEXT_TO_DATE", format: "YYYY-MM-DD", nulls: "PRESERVE" },
        { kind: "DATE" },
      ),
    },
    {
      name: "datetime",
      field: sourceField(
        0,
        {
          kind: "TEXT_TO_DATETIME",
          format: "YYYY-MM-DDTHH:mm:ss[.ffffff]",
          timezone: "FORBIDDEN",
          nulls: "PRESERVE",
        },
        { kind: "TIMESTAMP" },
      ),
    },
    {
      name: "instant",
      field: sourceField(
        0,
        {
          kind: "TEXT_TO_INSTANT",
          format: "YYYY-MM-DDTHH:mm:ss[.ffffff]Z",
          timezone: "UTC_REQUIRED",
          nulls: "PRESERVE",
        },
        { kind: "TIMESTAMPTZ" },
      ),
    },
    {
      name: "uuid",
      field: sourceField(
        0,
        { kind: "UUID_TEXT", invalid: "ERROR", nulls: "PRESERVE" },
        { kind: "TEXT" },
      ),
    },
  ];
  for (const item of cases) {
    const result = compiled({
      ...input,
      sourceFields: [item.field],
      dimensions: [],
      metrics: [
        {
          outputIndex: 0,
          semanticType: { kind: "INTEGER" },
          expression: {
            kind: "AGGREGATE",
            op: "COUNT",
            aggregationPolicy: "CARDINALITY",
            overflow: "ERROR",
            requireFiniteResult: false,
            resultType: { kind: "BIGINT" },
            expression: {
              kind: "SOURCE_FIELD",
              sourceFieldIndex: 0,
              resultType: item.field.resultType,
            },
          },
        },
      ],
      filters: [],
      orderBy: [],
      semanticLimit: undefined,
      output: [
        {
          outputIndex: 0,
          role: "METRIC",
          semanticKey: { kind: "METRIC", metricKey: item.name },
          name: item.name,
          label: item.name,
          semanticType: { kind: "INTEGER" },
          physicalType: { kind: "BIGINT" },
        },
      ],
    });
    const validation = result.validations.find(
      (command) => command.kind === "SOURCE_VALUE",
    );
    expect(validation?.statement.sql, item.name).toBeTruthy();
    expect(validation?.statement.sql, item.name).not.toContain("SELECT *");
  }
});

test("compiles IN parameters, NULL filters and omits absent semantic limit", () => {
  const input = plan();
  const field = input.dimensions[0].expression;
  const result = compiled({
    ...input,
    semanticLimit: undefined,
    filters: [
      {
        field,
        op: "IN",
        values: [
          {
            kind: "LITERAL",
            literalType: { kind: "STRING" },
            value: "A",
            resultType: { kind: "TEXT" },
          },
          {
            kind: "LITERAL",
            literalType: { kind: "STRING" },
            value: "B",
            resultType: { kind: "TEXT" },
          },
        ],
      },
      { field, op: "IS_NOT_NULL" },
    ],
  });
  expect(result.query.sql).toContain("IN ($1,$2)");
  expect(result.query.sql).toContain("IS NOT NULL");
  expect(result.query.sql).not.toContain("LIMIT");
  expect(result.query.parameters).toEqual([
    { kind: "VARCHAR", value: "A" },
    { kind: "VARCHAR", value: "B" },
  ]);
});

test("returns safe inconsistencies for forged indexes and limits", () => {
  const input = plan();
  expect(compilePhysicalQuery({ ...input, semanticLimit: 1001 })).toEqual({
    outcome: "INCONSISTENT_PHYSICAL_PLAN",
    path: "$.semanticLimit",
  });
  expect(
    compilePhysicalQuery({
      ...input,
      sourceFields: [{ ...input.sourceFields[0], columnIndex: 99 }],
    }),
  ).toEqual({
    outcome: "INCONSISTENT_PHYSICAL_PLAN",
    path: "$.sourceFields[0].columnIndex",
  });
});
