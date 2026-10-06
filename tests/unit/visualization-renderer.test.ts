import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AccessibleChartTable } from "../../src/components/visualizations/accessible-chart-table.tsx";
import { BarVisualization } from "../../src/components/visualizations/bar-visualization.tsx";
import { KpiVisualization } from "../../src/components/visualizations/kpi-visualization.tsx";
import { LineVisualization } from "../../src/components/visualizations/line-visualization.tsx";
import { TableVisualization } from "../../src/components/visualizations/table-visualization.tsx";
import type { KpiViewModel } from "../../src/modules/dashboard/domain/visualization-mapping.ts";
import {
  mixedTable,
  revenueByCityBar,
  revenueByDateLine,
  revenueKpi,
} from "../fixtures/visualizations/view-models.ts";

function render(component: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(component);
}

describe("visualization server renderers", () => {
  test("KPI distingue valor exato, aproximado, NULL e EMPTY", () => {
    expect(
      render(createElement(KpiVisualization, { viewModel: revenueKpi })),
    ).toContain("2.059,6100");
    expect(
      render(createElement(KpiVisualization, { viewModel: revenueKpi })),
    ).toContain("Valor exato");

    const approximate = {
      ...revenueKpi,
      value: {
        type: "NUMBER",
        value: "1.25",
        exactness: "APPROXIMATE",
        geometryValue: 1.25,
      },
    } as const satisfies KpiViewModel;
    expect(
      render(createElement(KpiVisualization, { viewModel: approximate })),
    ).toContain("Aproximado");

    const nullKpi = {
      ...revenueKpi,
      value: { type: "NULL" },
    } as const satisfies KpiViewModel;
    expect(
      render(createElement(KpiVisualization, { viewModel: nullKpi })),
    ).toContain("Sem valor");

    const empty = {
      type: "KPI",
      metric: revenueKpi.metric,
      state: "EMPTY",
    } as const satisfies KpiViewModel;
    expect(
      render(createElement(KpiVisualization, { viewModel: empty })),
    ).toContain("Nenhum resultado");
  });

  test("TABLE preserva headers, rows, duplicatas, NULL e precisão", () => {
    const html = render(
      createElement(TableVisualization, { viewModel: mixedTable }),
    );
    expect(html).toContain("Cidade");
    expect(
      html.match(/<span[^>]*aria-label="São José dos Campos"/g),
    ).toHaveLength(2);
    expect(html).toContain("9.007.199.254.740.993");
    expect(html).toContain("2.059,6100");
    expect(html).toContain("Sem valor");
    expect(html).toContain("≈ 1,25");
  });

  test("fallback BAR mantém valor sem geometryValue e todos os pontos", () => {
    const html = render(
      createElement(AccessibleChartTable, {
        viewModel: revenueByCityBar,
      }),
    );
    expect(html).toContain("900.719.925.474.099.312.345");
    expect(html.match(/<td[^>]*aria-label="Jacareí"/g)).toHaveLength(2);
    expect(html).toContain("Sem valor");
  });

  test("fallback LINE mantém timestamps, gap e valor sem geometria", () => {
    const html = render(
      createElement(AccessibleChartTable, {
        viewModel: revenueByDateLine,
      }),
    );
    expect(html.match(/<td[^>]*aria-label="02\/08\/2026"/g)).toHaveLength(2);
    expect(html).toContain("900.719.925.474.099.312.345,0000");
    expect(html).toContain("Sem valor");
  });

  test("wrappers distinguem valor sem geometria de NULL ou zero", () => {
    const bar = render(
      createElement(BarVisualization, { viewModel: revenueByCityBar }),
    );
    const line = render(
      createElement(LineVisualization, { viewModel: revenueByDateLine }),
    );
    expect(bar).toContain("1 valor não possui geometria visual");
    expect(line).toContain("1 valor não possui geometria visual");
    expect(bar).toContain("900.719.925.474.099.312.345");
    expect(line).toContain("900.719.925.474.099.312.345,0000");
  });
});
