import type { TableViewModel } from "@/modules/dashboard/domain/visualization-mapping";
import { formatQueryValue } from "./format-visualization-value";
import styles from "./visualizations.module.css";

const NUMERIC_TYPES = new Set(["INTEGER", "DECIMAL", "NUMBER"]);

export function TableVisualization({
  viewModel,
}: Readonly<{ viewModel: TableViewModel }>) {
  return (
    <div
      className={`${styles.tableViewport} ${styles.tableVerticalViewport}`}
      role="region"
      aria-label="Dados da visualização"
      tabIndex={0}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            {viewModel.columns.map((column) => (
              <th
                key={`${column.role}:${column.key}`}
                scope="col"
                className={
                  NUMERIC_TYPES.has(column.semanticType.kind)
                    ? styles.numericCell
                    : undefined
                }
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {viewModel.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, columnIndex) => {
                const formatted = formatQueryValue(value);
                const approximate = formatted.exactness === "APPROXIMATE";
                return (
                  <td
                    key={`${viewModel.columns[columnIndex].key}:${columnIndex}`}
                    className={
                      NUMERIC_TYPES.has(
                        viewModel.columns[columnIndex].semanticType.kind,
                      )
                        ? styles.numericCell
                        : undefined
                    }
                  >
                    <span aria-label={formatted.accessibleText}>
                      {approximate ? "≈ " : ""}
                      {formatted.text}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
