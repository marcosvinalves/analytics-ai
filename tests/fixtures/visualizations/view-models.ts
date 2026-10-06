import type {
  BarViewModel,
  KpiViewModel,
  LineViewModel,
  TableViewModel,
} from "../../../src/modules/dashboard/domain/visualization-mapping.ts";

const keys = {
  city: "10000000-0000-4000-8000-000000000001",
  date: "10000000-0000-4000-8000-000000000002",
  revenue: "10000000-0000-4000-8000-000000000003",
  quantity: "10000000-0000-4000-8000-000000000004",
  ratio: "10000000-0000-4000-8000-000000000005",
} as const;

const revenue = {
  role: "METRIC",
  key: keys.revenue,
  label: "Receita",
  semanticType: { kind: "DECIMAL", precision: 38, scale: 4 },
} as const;

export const revenueKpi = {
  type: "KPI",
  metric: revenue,
  state: "VALUE",
  value: {
    type: "DECIMAL",
    value: "2059.6100",
    exactness: "EXACT",
    geometryValue: 2059.61,
  },
} as const satisfies KpiViewModel;

export const revenueByCityBar = {
  type: "BAR",
  category: {
    role: "DIMENSION",
    key: keys.city,
    label: "Cidade",
    semanticType: { kind: "STRING" },
  },
  value: revenue,
  points: [
    {
      category: { type: "STRING", value: "São José dos Campos" },
      value: {
        type: "DECIMAL",
        value: "818.7100",
        exactness: "EXACT",
        geometryValue: 818.71,
      },
    },
    {
      category: { type: "STRING", value: "Taubaté" },
      value: {
        type: "DECIMAL",
        value: "689.5000",
        exactness: "EXACT",
        geometryValue: 689.5,
      },
    },
    {
      category: { type: "STRING", value: "Jacareí" },
      value: {
        type: "DECIMAL",
        value: "551.4000",
        exactness: "EXACT",
        geometryValue: 551.4,
      },
    },
    {
      category: { type: "STRING", value: "Jacareí" },
      value: { type: "NULL" },
    },
    {
      category: {
        type: "STRING",
        value: "Categoria com nome deliberadamente longo para validar o layout",
      },
      value: {
        type: "INTEGER",
        value: "900719925474099312345",
        exactness: "EXACT",
      },
    },
  ],
} as const satisfies BarViewModel;

export const revenueByDateLine = {
  type: "LINE",
  x: {
    role: "DIMENSION",
    key: keys.date,
    label: "Data",
    semanticType: { kind: "DATE" },
  },
  y: revenue,
  points: [
    {
      x: { type: "DATE", value: "2026-08-01" },
      y: {
        type: "DECIMAL",
        value: "100.1000",
        exactness: "EXACT",
        geometryValue: 100.1,
      },
    },
    {
      x: { type: "DATE", value: "2026-08-02" },
      y: { type: "NULL" },
    },
    {
      x: { type: "DATE", value: "2026-08-02" },
      y: {
        type: "DECIMAL",
        value: "900719925474099312345.0000",
        exactness: "EXACT",
      },
    },
    {
      x: { type: "DATE", value: "2026-08-03" },
      y: {
        type: "NUMBER",
        value: "3.141592653589793",
        exactness: "APPROXIMATE",
        geometryValue: 3.141592653589793,
      },
    },
  ],
} as const satisfies LineViewModel;

export const mixedTable = {
  type: "TABLE",
  columns: [
    {
      role: "DIMENSION",
      key: keys.city,
      label: "Cidade",
      semanticType: { kind: "STRING" },
    },
    {
      role: "METRIC",
      key: keys.quantity,
      label: "Quantidade",
      semanticType: { kind: "INTEGER" },
    },
    revenue,
    {
      role: "METRIC",
      key: keys.ratio,
      label: "Índice",
      semanticType: { kind: "NUMBER" },
    },
  ],
  rows: [
    [
      { type: "STRING", value: "São José dos Campos" },
      { type: "INTEGER", value: "9007199254740993" },
      { type: "DECIMAL", value: "2059.6100" },
      { type: "NUMBER", value: "1.25" },
    ],
    [
      { type: "STRING", value: "São José dos Campos" },
      { type: "INTEGER", value: "0" },
      { type: "NULL" },
      { type: "NUMBER", value: "0" },
    ],
  ],
} as const satisfies TableViewModel;

export function fiveHundredPointLine(): LineViewModel {
  return {
    type: "LINE",
    x: revenueByDateLine.x,
    y: revenueByDateLine.y,
    points: Array.from({ length: 500 }, (_, index) => ({
      x: {
        type: "DATE" as const,
        value: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
      },
      y:
        index === 250
          ? ({ type: "NULL" } as const)
          : ({
              type: "DECIMAL" as const,
              value: `${index}.0000`,
              exactness: "EXACT" as const,
              geometryValue: index,
            } as const),
    })),
  };
}

export function fiveHundredPointBar(): BarViewModel {
  return {
    type: "BAR",
    category: revenueByCityBar.category,
    value: revenueByCityBar.value,
    points: Array.from({ length: 500 }, (_, index) => ({
      category: { type: "STRING" as const, value: `Categoria ${index}` },
      value:
        index === 250
          ? ({
              type: "INTEGER" as const,
              value: "900719925474099312345",
              exactness: "EXACT" as const,
            } as const)
          : ({
              type: "DECIMAL" as const,
              value: `${index}.0000`,
              exactness: "EXACT" as const,
              geometryValue: index,
            } as const),
    })),
  };
}
