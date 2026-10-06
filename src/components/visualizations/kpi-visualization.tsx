import type { KpiViewModel } from "@/modules/dashboard/domain/visualization-mapping";
import { formatNumericVisualizationValue } from "./format-visualization-value";
import styles from "./visualizations.module.css";

export function KpiVisualization({
  viewModel,
}: Readonly<{ viewModel: KpiViewModel }>) {
  if (viewModel.state === "EMPTY")
    return (
      <section className={styles.kpi} aria-label={viewModel.metric.label}>
        <p className={styles.kpiLabel}>{viewModel.metric.label}</p>
        <p className={styles.empty}>Nenhum resultado</p>
      </section>
    );

  const formatted = formatNumericVisualizationValue(viewModel.value);
  return (
    <section className={styles.kpi} aria-label={viewModel.metric.label}>
      <p className={styles.kpiLabel}>{viewModel.metric.label}</p>
      <p className={styles.kpiValue} aria-label={formatted.accessibleText}>
        {formatted.text}
      </p>
      {formatted.exactness && (
        <p className={styles.exactness}>
          {formatted.exactness === "EXACT" ? "Valor exato" : "≈ Aproximado"}
        </p>
      )}
    </section>
  );
}
