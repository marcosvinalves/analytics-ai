import { describe, expect, test } from "vitest";
import {
  mapVisualization,
  type VisualizationMappingResult,
} from "../../src/modules/dashboard/domain/visualization-mapping.ts";
import {
  validateVisualizationCompatibility,
  type VisualizationSpecV1,
} from "../../src/modules/dashboard/domain/visualization-spec.ts";
import type { QueryExplanation } from "../../src/modules/query/domain/query-explanation.ts";
import type {
  QueryResult,
  QueryResultColumn,
  QueryValue,
} from "../../src/modules/query/domain/query-result.ts";
import type { SemanticType } from "../../src/modules/semantic/domain/semantic-field.ts";

const keys = {
  category: "11111111-1111-4111-8111-111111111111",
  metric: "22222222-2222-4222-8222-222222222222",
  secondMetric: "33333333-3333-4333-8333-333333333333",
  date: "44444444-4444-4444-8444-444444444444",
};

function column(
  key: string,
  role: "DIMENSION" | "METRIC",
  semanticType: SemanticType,
  label = key,
): QueryResultColumn {
  return { key, role, semanticType, label };
}

function result(
  columns: readonly QueryResultColumn[],
  rows: readonly (readonly QueryValue[])[],
): QueryResult {
  return { columns, rows };
}

function kpi(key = keys.metric): VisualizationSpecV1 {
  return {
    version: 1,
    type: "KPI",
    value: { role: "METRIC", key },
  };
}

function bar(): VisualizationSpecV1 {
  return {
    version: 1,
    type: "BAR",
    category: { role: "DIMENSION", key: keys.category },
    value: { role: "METRIC", key: keys.metric },
  };
}

function line(): VisualizationSpecV1 {
  return {
    version: 1,
    type: "LINE",
    x: { role: "DIMENSION", key: keys.date },
    y: { role: "METRIC", key: keys.metric },
  };
}

const noOrder: QueryExplanation["orderBy"] = [];

function temporalOrder(
  direction: "ASC" | "DESC" = "ASC",
): QueryExplanation["orderBy"] {
  return [
    {
      target: { role: "DIMENSION", key: keys.date, label: "Date" },
      direction,
      nulls: "LAST",
    },
  ];
}

function mapped(value: VisualizationMappingResult) {
  expect(value.outcome).toBe("MAPPED");
  if (value.outcome !== "MAPPED") throw new Error("Expected MAPPED");
  return value.viewModel;
}

describe("KPI mapping", () => {
  test.each([
    [
      { kind: "INTEGER" } as const,
      { type: "INTEGER", value: "9223372036854775808" } as const,
      "EXACT",
      9223372036854776000,
    ],
    [
      { kind: "DECIMAL", precision: 38, scale: 2 } as const,
      { type: "DECIMAL", value: "2059.61" } as const,
      "EXACT",
      2059.61,
    ],
    [
      { kind: "NUMBER" } as const,
      { type: "NUMBER", value: "1.25" } as const,
      "APPROXIMATE",
      1.25,
    ],
  ])(
    "preserva valor numérico autoritativo %#",
    (semanticType, value, exactness, geometryValue) => {
      const viewModel = mapped(
        mapVisualization(
          kpi(),
          result([column(keys.metric, "METRIC", semanticType)], [[value]]),
          noOrder,
        ),
      );
      expect(viewModel).toMatchObject({
        type: "KPI",
        state: "VALUE",
        value: { ...value, exactness, geometryValue },
      });
    },
  );

  test("preserva scale DECIMAL", () => {
    const viewModel = mapped(
      mapVisualization(
        kpi(),
        result(
          [
            column(keys.metric, "METRIC", {
              kind: "DECIMAL",
              precision: 38,
              scale: 2,
            }),
          ],
          [[{ type: "DECIMAL", value: "2000.00" }]],
        ),
        noOrder,
      ),
    );
    expect(viewModel).toMatchObject({
      value: { value: "2000.00", geometryValue: 2000 },
    });
  });

  test("diferencia EMPTY, NULL e zero", () => {
    const columns = [column(keys.metric, "METRIC", { kind: "INTEGER" })];
    expect(
      mapped(mapVisualization(kpi(), result(columns, []), noOrder)),
    ).toMatchObject({ type: "KPI", state: "EMPTY" });
    expect(
      mapped(
        mapVisualization(kpi(), result(columns, [[{ type: "NULL" }]]), noOrder),
      ),
    ).toMatchObject({ type: "KPI", state: "VALUE", value: { type: "NULL" } });
    expect(
      mapped(
        mapVisualization(
          kpi(),
          result(columns, [[{ type: "INTEGER", value: "0" }]]),
          noOrder,
        ),
      ),
    ).toMatchObject({
      type: "KPI",
      state: "VALUE",
      value: { type: "INTEGER", value: "0", geometryValue: 0 },
    });
  });

  test("rejeita mais de uma row", () => {
    expect(
      mapVisualization(
        kpi(),
        result(
          [column(keys.metric, "METRIC", { kind: "INTEGER" })],
          [
            [{ type: "INTEGER", value: "1" }],
            [{ type: "INTEGER", value: "2" }],
          ],
        ),
        noOrder,
      ),
    ).toEqual({
      outcome: "INVALID_RESULT",
      reason: "KPI_CARDINALITY_INVALID",
    });
  });

  test("omite geometryValue não finito sem alterar NUMBER autoritativo", () => {
    const viewModel = mapped(
      mapVisualization(
        kpi(),
        result(
          [column(keys.metric, "METRIC", { kind: "NUMBER" })],
          [[{ type: "NUMBER", value: "1e9999" }]],
        ),
        noOrder,
      ),
    );
    expect(viewModel).toMatchObject({
      value: {
        type: "NUMBER",
        value: "1e9999",
        exactness: "APPROXIMATE",
      },
    });
    expect(viewModel.type === "KPI" && viewModel.state === "VALUE").toBe(true);
    if (viewModel.type === "KPI" && viewModel.state === "VALUE")
      expect("geometryValue" in viewModel.value).toBe(false);
  });
});

describe("TABLE mapping", () => {
  test("preserva columns, rows, NULL e todos os tipos sem conversão", () => {
    const columns = [
      column(keys.category, "DIMENSION", { kind: "STRING" }, "Text"),
      column(keys.secondMetric, "METRIC", { kind: "BOOLEAN" }, "Boolean"),
      column(keys.metric, "METRIC", { kind: "INTEGER" }, "Integer"),
      column("55555555-5555-4555-8555-555555555555", "METRIC", {
        kind: "DECIMAL",
        precision: 18,
        scale: 2,
      }),
      column("66666666-6666-4666-8666-666666666666", "METRIC", {
        kind: "NUMBER",
      }),
      column(keys.date, "DIMENSION", { kind: "DATE" }, "Date"),
      column("77777777-7777-4777-8777-777777777777", "DIMENSION", {
        kind: "DATETIME",
      }),
      column("88888888-8888-4888-8888-888888888888", "DIMENSION", {
        kind: "INSTANT",
      }),
    ];
    const rows: QueryValue[][] = [
      [
        { type: "STRING", value: " B " },
        { type: "BOOLEAN", value: true },
        { type: "INTEGER", value: "9007199254740993" },
        { type: "DECIMAL", value: "2000.00" },
        { type: "NUMBER", value: "1.25" },
        { type: "DATE", value: "2026-01-02" },
        { type: "DATETIME", value: "2026-01-02T03:04:05.123456" },
        { type: "INSTANT", value: "2026-01-02T03:04:05.123456Z" },
      ],
      Array.from({ length: 8 }, () => ({ type: "NULL" }) as const),
    ];
    const input = result(columns, rows);
    const viewModel = mapped(
      mapVisualization({ version: 1, type: "TABLE" }, input, noOrder),
    );
    expect(viewModel).toEqual({ type: "TABLE", columns, rows });
    expect(viewModel.type === "TABLE" && viewModel.columns).not.toBe(columns);
    expect(viewModel.type === "TABLE" && viewModel.rows).not.toBe(rows);
    expect(viewModel.type === "TABLE" && viewModel.rows[0][0]).not.toBe(
      rows[0][0],
    );
  });
});

describe("BAR mapping", () => {
  test.each([
    [{ kind: "STRING" } as const, { type: "STRING", value: "A" } as const],
    [{ kind: "BOOLEAN" } as const, { type: "BOOLEAN", value: true } as const],
  ])("mapeia category %#", (semanticType, category) => {
    const viewModel = mapped(
      mapVisualization(
        bar(),
        result(
          [
            column(keys.category, "DIMENSION", semanticType),
            column(keys.metric, "METRIC", { kind: "INTEGER" }),
          ],
          [[category, { type: "INTEGER", value: "2" }]],
        ),
        noOrder,
      ),
    );
    expect(viewModel).toMatchObject({
      type: "BAR",
      points: [{ category, value: { value: "2", exactness: "EXACT" } }],
    });
  });

  test("preserva order, duplicates e NULL sem agrupar", () => {
    const viewModel = mapped(
      mapVisualization(
        bar(),
        result(
          [
            column(keys.category, "DIMENSION", { kind: "STRING" }),
            column(keys.metric, "METRIC", {
              kind: "DECIMAL",
              precision: 18,
              scale: 2,
            }),
          ],
          [
            [
              { type: "STRING", value: "B" },
              { type: "DECIMAL", value: "2.00" },
            ],
            [
              { type: "STRING", value: "A" },
              { type: "DECIMAL", value: "1.00" },
            ],
            [
              { type: "STRING", value: "B" },
              { type: "DECIMAL", value: "3.00" },
            ],
            [{ type: "NULL" }, { type: "NULL" }],
          ],
        ),
        noOrder,
      ),
    );
    expect(viewModel.type === "BAR" && viewModel.points).toMatchObject([
      { category: { value: "B" }, value: { value: "2.00" } },
      { category: { value: "A" }, value: { value: "1.00" } },
      { category: { value: "B" }, value: { value: "3.00" } },
      { category: { type: "NULL" }, value: { type: "NULL" } },
    ]);
  });

  test.each([
    [
      { kind: "INTEGER" } as const,
      { type: "INTEGER", value: "3" } as const,
      "EXACT",
    ],
    [
      { kind: "DECIMAL", precision: 18, scale: 2 } as const,
      { type: "DECIMAL", value: "3.00" } as const,
      "EXACT",
    ],
    [
      { kind: "NUMBER" } as const,
      { type: "NUMBER", value: "3.5" } as const,
      "APPROXIMATE",
    ],
  ])("preserva Metric numérica %#", (semanticType, value, exactness) => {
    const viewModel = mapped(
      mapVisualization(
        bar(),
        result(
          [
            column(keys.category, "DIMENSION", { kind: "STRING" }),
            column(keys.metric, "METRIC", semanticType),
          ],
          [[{ type: "STRING", value: "A" }, value]],
        ),
        noOrder,
      ),
    );
    expect(viewModel).toMatchObject({
      points: [{ value: { ...value, exactness } }],
    });
  });
});

describe("LINE mapping", () => {
  test.each([
    ["DATE", "2026-03-01"],
    ["DATETIME", "2026-03-01T12:30:00.123456"],
    ["INSTANT", "2026-03-01T12:30:00.123456Z"],
  ] as const)("preserva %s textual e row order", (kind, first) => {
    const second = kind === "DATE" ? "2025-01-01" : first.replace("12", "11");
    const viewModel = mapped(
      mapVisualization(
        line(),
        result(
          [
            column(keys.date, "DIMENSION", { kind }),
            column(keys.metric, "METRIC", { kind: "NUMBER" }),
          ],
          [
            [
              { type: kind, value: first },
              { type: "NUMBER", value: "2.5" },
            ],
            [
              { type: kind, value: second },
              { type: "NUMBER", value: "1.5" },
            ],
            [{ type: "NULL" }, { type: "NULL" }],
          ],
        ),
        temporalOrder(),
      ),
    );
    expect(viewModel.type === "LINE" && viewModel.points).toMatchObject([
      { x: { type: kind, value: first }, y: { value: "2.5" } },
      { x: { type: kind, value: second }, y: { value: "1.5" } },
      { x: { type: "NULL" }, y: { type: "NULL" } },
    ]);
    expect(JSON.stringify(viewModel)).toContain(first);
    expect(JSON.stringify(viewModel)).not.toContain('geometryValue":17');
  });
});

test("LINE preserva DECIMAL exato no eixo y", () => {
  const viewModel = mapped(
    mapVisualization(
      line(),
      result(
        [
          column(keys.date, "DIMENSION", { kind: "DATE" }),
          column(keys.metric, "METRIC", {
            kind: "DECIMAL",
            precision: 38,
            scale: 2,
          }),
        ],
        [
          [
            { type: "DATE", value: "2026-03-01" },
            { type: "DECIMAL", value: "2059.61" },
          ],
        ],
      ),
      temporalOrder(),
    ),
  );
  expect(viewModel).toMatchObject({
    points: [
      {
        y: {
          type: "DECIMAL",
          value: "2059.61",
          exactness: "EXACT",
          geometryValue: 2059.61,
        },
      },
    ],
  });
});

describe("compatibility e resultados inconsistentes", () => {
  test.each([
    [
      kpi("99999999-9999-4999-8999-999999999999"),
      result([column(keys.metric, "METRIC", { kind: "INTEGER" })], []),
      noOrder,
      "OUTPUT_NOT_FOUND",
    ],
    [
      {
        version: 1,
        type: "KPI",
        value: { role: "DIMENSION", key: keys.metric },
      } as const,
      result([column(keys.metric, "METRIC", { kind: "INTEGER" })], []),
      noOrder,
      "OUTPUT_ROLE_MISMATCH",
    ],
    [
      kpi(),
      result([column(keys.metric, "METRIC", { kind: "STRING" })], []),
      noOrder,
      "OUTPUT_TYPE_INCOMPATIBLE",
    ],
    [
      line(),
      result(
        [
          column(keys.date, "DIMENSION", { kind: "DATE" }),
          column(keys.metric, "METRIC", { kind: "INTEGER" }),
        ],
        [],
      ),
      temporalOrder("DESC"),
      "LINE_REQUIRES_ASCENDING_TEMPORAL_ORDER",
    ],
  ])(
    "delega incompatibilidade %# ao T-023",
    (spec, input, orderBy, issueCode) => {
      const expected = validateVisualizationCompatibility(spec, {
        phase: "POST_EXECUTION",
        columns: input.columns,
        orderBy,
      });
      const actual = mapVisualization(spec, input, orderBy);
      expect(expected).toMatchObject({
        compatible: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: issueCode }),
        ]),
      });
      expect(actual).toEqual({
        outcome: "INCOMPATIBLE",
        issues: expected.compatible ? [] : expected.issues,
      });
    },
  );

  test.each([
    [null as unknown as QueryResult, "INVALID_RESULT_STRUCTURE"],
    [
      result(
        [
          column(keys.metric, "METRIC", { kind: "INTEGER" }),
          column(keys.metric, "METRIC", { kind: "INTEGER" }),
        ],
        [],
      ),
      "DUPLICATE_OUTPUT_IDENTITY",
    ],
    [
      result([column(keys.metric, "METRIC", { kind: "INTEGER" })], [[]]),
      "ROW_WIDTH_MISMATCH",
    ],
    [
      result([column(keys.metric, "METRIC", { kind: "INTEGER" })], [
        [{ type: "STRING", value: "internal" }],
      ] as unknown as QueryValue[][]),
      "CELL_TYPE_MISMATCH",
    ],
  ])("rejeita resultado inconsistente %#", (input, reason) => {
    expect(mapVisualization(kpi(), input, noOrder)).toEqual({
      outcome: "INVALID_RESULT",
      reason,
    });
    expect(
      JSON.stringify(mapVisualization(kpi(), input, noOrder)),
    ).not.toContain("internal");
  });
});

test("reconstrói e congela output sem modificar ou congelar inputs", () => {
  const cell = { type: "INTEGER" as const, value: "10" };
  const input = {
    columns: [column(keys.metric, "METRIC", { kind: "INTEGER" }, "Total")],
    rows: [[cell]],
  };
  const spec = kpi();
  const orderBy: QueryExplanation["orderBy"] = [];
  const before = JSON.stringify({ input, spec, orderBy });
  const output = mapVisualization(spec, input, orderBy);
  expect(JSON.stringify({ input, spec, orderBy })).toBe(before);
  expect(Object.isFrozen(input)).toBe(false);
  expect(Object.isFrozen(input.columns)).toBe(false);
  expect(Object.isFrozen(spec)).toBe(false);
  expect(Object.isFrozen(output)).toBe(true);
  expect(output.outcome).toBe("MAPPED");
  if (output.outcome !== "MAPPED") throw new Error("Expected MAPPED");
  expect(Object.isFrozen(output.viewModel)).toBe(true);
  expect(
    output.viewModel.type === "KPI" && Object.isFrozen(output.viewModel.metric),
  ).toBe(true);
  cell.value = "11";
  expect(output.viewModel).toMatchObject({ value: { value: "10" } });
});
