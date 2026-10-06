import type { LineViewModel } from "@/modules/dashboard/domain/visualization-mapping";
import { AccessibleChartTable } from "./accessible-chart-table";
import { toLineChartData } from "./chart-data";
import { LineChartClient } from "./line-chart-client";
import styles from "./visualizations.module.css";

export function LineVisualization({
  viewModel,
}: Readonly<{ viewModel: LineViewModel }>) {
  const data = toLineChartData(viewModel);
  const missingGeometry = data.filter(
    (point) =>
      point.authoritativeValue !== null && point.geometryValue === null,
  ).length;
  return (
    <section className={styles.chart} aria-label="Gráfico de linha">
      <LineChartClient
        data={data}
        xLabel={viewModel.x.label}
        yLabel={viewModel.y.label}
      />
      {missingGeometry > 0 && (
        <p className={styles.geometryNotice} role="note">
          {missingGeometry === 1
            ? "1 valor não possui geometria visual e aparece como lacuna; consulte a tabela para o valor completo."
            : `${missingGeometry} valores não possuem geometria visual e aparecem como lacunas; consulte a tabela para os valores completos.`}
        </p>
      )}
      <AccessibleChartTable viewModel={viewModel} />
    </section>
  );
}
