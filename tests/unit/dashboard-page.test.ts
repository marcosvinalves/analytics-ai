import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DashboardFailure,
  DashboardView,
  widgetContext,
} from "../../src/components/dashboard/dashboard-view.tsx";
import type { ExecuteDashboardResult } from "../../src/modules/dashboard/application/execute-dashboard.ts";
import type { ExecuteDashboardWidgetResult } from "../../src/modules/dashboard/application/execute-dashboard-widget.ts";
import type { QueryExplanation } from "../../src/modules/query/domain/query-explanation.ts";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const explanation = Object.freeze({
  version: 1,
  model: { id: "model-secret-id", name: "Vendas" },
  revision: {
    id: "revision-secret-id",
    revisionNumber: 1,
    label: "Vendas publicadas",
    publishedAt: "2026-10-05T12:00:00.000Z",
  },
  dataset: { id: "dataset-secret-id", name: "Vendas 2026" },
  datasetVersion: { id: "version-secret-id", versionNumber: 1 },
  metrics: [
    {
      metricKey: "revenue",
      name: "revenue",
      label: "Receita",
      resultType: { kind: "DECIMAL", precision: 18, scale: 2 },
      numericSemantics: "EXACT",
      expression: {
        kind: "AGGREGATE",
        operator: "SUM",
        expression: {
          kind: "BINARY",
          operator: "MULTIPLY",
          left: { kind: "FIELD", fieldKey: "quantity", label: "Quantidade" },
          right: { kind: "FIELD", fieldKey: "price", label: "Preço unitário" },
        },
      },
      dependencies: [],
    },
  ],
  dimensions: [],
  filters: { combination: "AND", items: [] },
  orderBy: [],
  outputs: [
    {
      key: "revenue",
      label: "Receita",
      role: "METRIC",
      semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
      numericSemantics: "EXACT",
    },
  ],
  resultShape: { rowCount: 1, columnCount: 1 },
} satisfies QueryExplanation);

const metric = {
  role: "METRIC",
  key: "revenue",
  label: "Receita",
  semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
} as const;

const success: ExecuteDashboardWidgetResult = {
  status: "SUCCESS",
  widgetId: "11111111-1111-4111-8111-111111111111",
  viewModel: {
    type: "KPI",
    metric,
    state: "VALUE",
    value: {
      type: "DECIMAL",
      value: "2059.61",
      exactness: "EXACT",
      geometryValue: 2059.61,
    },
  },
  explanation,
};

function execution(
  results: readonly {
    result: ExecuteDashboardWidgetResult;
    layout?: { x: number; y: number; width: number; height: number } | null;
  }[],
  status: "COMPLETED" | "CANCELLED" = "COMPLETED",
): Extract<ExecuteDashboardResult, { status: "COMPLETED" | "CANCELLED" }> {
  return {
    status,
    dashboardId: "22222222-2222-4222-8222-222222222222",
    widgets: results.map((item, index) => ({
      widgetId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      layout:
        item.layout === undefined
          ? { x: index, y: 0, width: 1, height: 1 }
          : item.layout,
      result: item.result,
    })),
  };
}

function render(result: ReturnType<typeof execution>): string {
  return renderToStaticMarkup(
    createElement(DashboardView, {
      name: "Visão comercial",
      description: "Indicadores aprovados",
      execution: result,
    }),
  );
}

beforeEach(() => refresh.mockClear());

describe("Dashboard read-only presentation", () => {
  test("renderiza SUCCESS e EMPTY com renderer e explicação sem IDs internos", () => {
    const empty: ExecuteDashboardWidgetResult = {
      status: "EMPTY",
      widgetId: success.widgetId,
      viewModel: { type: "KPI", metric, state: "EMPTY" },
      explanation,
    };
    const html = render(execution([{ result: success }, { result: empty }]));
    expect(html).toContain("Visão comercial");
    expect(html).toContain("2.059,61");
    expect(html).toContain("Nenhum dado corresponde");
    expect(
      html.match(/<button[^>]*>Como foi calculado\?<\/button>/g),
    ).toHaveLength(2);
    expect(html).not.toContain("secret-id");
  });

  test("isola BROKEN, ERROR, NOT_FOUND e CANCELLED com mensagens humanas", () => {
    const results: ExecuteDashboardWidgetResult[] = [
      {
        status: "BROKEN",
        widgetId: "a",
        reason: "SEMANTIC_QUERY_INVALID",
      },
      {
        status: "ERROR",
        widgetId: "b",
        reason: "QUERY_TIMEOUT",
      },
      { status: "NOT_FOUND" },
      { status: "CANCELLED", widgetId: "c" },
    ];
    const html = render(execution(results.map((result) => ({ result }))));
    expect(html).toContain("Consulta do widget inválida");
    expect(html).toContain("O cálculo demorou além do limite");
    expect(html).toContain("Widget indisponível");
    expect(html).toContain("Execução interrompida");
    expect(html).not.toContain("SEMANTIC_QUERY_INVALID");
    expect(html).not.toContain("QUERY_TIMEOUT");
    expect(html).not.toContain("Como foi calculado?");
  });

  test("nunca apresenta reason codes de BROKEN ou ERROR", () => {
    const brokenReasons = [
      "SEMANTIC_QUERY_INVALID",
      "VISUALIZATION_SPEC_INVALID",
      "LAYOUT_INVALID",
      "WORKSPACE_RELATION_INVALID",
      "VISUALIZATION_INCOMPATIBLE",
    ] as const;
    const errorReasons = [
      "MODEL_NOT_PUBLISHED",
      "QUERY_NOT_SUPPORTED",
      "SOURCE_UNAVAILABLE",
      "SOURCE_INCONSISTENT",
      "QUERY_EXECUTION_FAILED",
      "QUERY_TIMEOUT",
      "RESULT_LIMIT_EXCEEDED",
      "RESULT_TOO_LARGE",
      "INCONSISTENT_WIDGET_METADATA",
      "INCONSISTENT_QUERY_PIPELINE",
      "OPERATIONAL_FAILURE",
    ] as const;
    const results: ExecuteDashboardWidgetResult[] = [
      ...brokenReasons.map((reason) => ({
        status: "BROKEN" as const,
        widgetId: reason,
        reason,
      })),
      ...errorReasons.map((reason) => ({
        status: "ERROR" as const,
        widgetId: reason,
        reason,
      })),
      {
        status: "ERROR",
        widgetId: "processing",
        reason: "DATA_NOT_READY",
        dataStatus: "PROCESSING",
      },
      {
        status: "ERROR",
        widgetId: "failed",
        reason: "DATA_NOT_READY",
        dataStatus: "FAILED",
      },
    ];
    const html = render(execution(results.map((result) => ({ result }))));
    for (const reason of [...brokenReasons, ...errorReasons, "DATA_NOT_READY"])
      expect(html).not.toContain(reason);
  });

  test("separa layout nulo e preserva CANCELLED top-level e inputs", () => {
    const input = execution(
      [
        { result: success, layout: { x: 2, y: 3, width: 4, height: 2 } },
        {
          result: {
            status: "BROKEN",
            widgetId: "broken",
            reason: "LAYOUT_INVALID",
          },
          layout: null,
        },
      ],
      "CANCELLED",
    );
    const before = JSON.stringify(input);
    const html = render(input);
    expect(html).toContain("Widgets que precisam de atenção");
    expect(html).toContain("--widget-column:3 / span 4");
    expect(html).toContain("A atualização foi interrompida");
    expect(JSON.stringify(input)).toBe(before);
  });

  test("renderiza Dashboard vazio e falha top-level segura", () => {
    expect(render(execution([]))).toContain("Dashboard vazio");
    const html = renderToStaticMarkup(
      createElement(DashboardFailure, { inconsistent: true }),
    );
    expect(html).toContain(
      "Não foi possível carregar este Dashboard com segurança",
    );
    expect(html).not.toContain("INCONSISTENT_DASHBOARD_METADATA");
  });

  test("deriva somente contexto de labels existentes", () => {
    expect(widgetContext(success.viewModel).title).toBe("Receita");
    expect(
      widgetContext({
        type: "BAR",
        category: {
          role: "DIMENSION",
          key: "city",
          label: "Cidade",
          semanticType: { kind: "STRING" },
        },
        value: metric,
        points: [],
      }).title,
    ).toBe("Receita por Cidade");
    expect(
      widgetContext({
        type: "LINE",
        x: {
          role: "DIMENSION",
          key: "date",
          label: "Data",
          semanticType: { kind: "DATE" },
        },
        y: metric,
        points: [],
      }).title,
    ).toBe("Receita por Data");
    expect(
      widgetContext({
        type: "TABLE",
        columns: [metric],
        rows: [],
      }),
    ).toEqual({ title: "Tabela de dados", subtitle: "Receita" });
  });
});
