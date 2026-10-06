import type { BarViewModel } from "@/modules/dashboard/domain/visualization-mapping";
import { AccessibleChartTable } from "./accessible-chart-table";
import { BarChartClient } from "./bar-chart-client";
import { toBarChartData } from "./chart-data";
import styles from "./visualizations.module.css";

export function BarVisualization({
  viewModel,
}: Readonly<{ viewModel: BarViewModel }>) {
  const data = toBarChartData(viewModel);
  const missingGeometry = data.filter(
    (point) =>
      point.authoritativeValue !== null && point.geometryValue === null,
  ).length;
  return (
    <section className={styles.chart} aria-label="Gráfico de barras">
      <BarChartClient
        data={data}
        categoryLabel={viewModel.category.label}
        valueLabel={viewModel.value.label}
      />
      {missingGeometry > 0 && (
        <p className={styles.geometryNotice} role="note">
          {missingGeometry === 1
            ? "1 valor não possui geometria visual; consulte a tabela para o valor completo."
            : `${missingGeometry} valores não possuem geometria visual; consulte a tabela para os valores completos.`}
        </p>
      )}
      <AccessibleChartTable viewModel={viewModel} />
    </section>
  );
}
