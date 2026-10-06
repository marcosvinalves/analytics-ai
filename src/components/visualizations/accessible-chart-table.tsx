import type {
  BarViewModel,
  LineViewModel,
} from "@/modules/dashboard/domain/visualization-mapping";
import {
  formatCategoricalVisualizationValue,
  formatNumericVisualizationValue,
  formatTemporalVisualizationValue,
} from "./format-visualization-value";
import styles from "./visualizations.module.css";

export function AccessibleChartTable({
  viewModel,
}: Readonly<{ viewModel: BarViewModel | LineViewModel }>) {
  const firstLabel =
    viewModel.type === "BAR" ? viewModel.category.label : viewModel.x.label;
  const secondLabel =
    viewModel.type === "BAR" ? viewModel.value.label : viewModel.y.label;

  return (
    <details className={styles.chartTableDisclosure}>
      <summary>Ver dados em tabela</summary>
      <div className={styles.tableViewport}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{firstLabel}</th>
              <th scope="col" className={styles.numericCell}>
                {secondLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {(viewModel.type === "BAR"
              ? viewModel.points.map((point) => ({
                  first: formatCategoricalVisualizationValue(point.category),
                  numeric: formatNumericVisualizationValue(point.value),
                }))
              : viewModel.points.map((point) => ({
                  first: formatTemporalVisualizationValue(point.x),
                  numeric: formatNumericVisualizationValue(point.y),
                }))
            ).map(({ first, numeric }, index) => {
              return (
                <tr key={index}>
                  <td aria-label={first.accessibleText}>{first.text}</td>
                  <td
                    className={styles.numericCell}
                    aria-label={numeric.accessibleText}
                  >
                    {numeric.exactness === "APPROXIMATE" ? "≈ " : ""}
                    {numeric.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
