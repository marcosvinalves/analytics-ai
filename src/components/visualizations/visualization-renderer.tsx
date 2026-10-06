import type { VisualizationViewModel } from "@/modules/dashboard/domain/visualization-mapping";
import { BarVisualization } from "./bar-visualization";
import { KpiVisualization } from "./kpi-visualization";
import { LineVisualization } from "./line-visualization";
import { TableVisualization } from "./table-visualization";

export function VisualizationRenderer({
  viewModel,
}: Readonly<{ viewModel: VisualizationViewModel }>) {
  if (viewModel.type === "KPI")
    return <KpiVisualization viewModel={viewModel} />;
  if (viewModel.type === "TABLE")
    return <TableVisualization viewModel={viewModel} />;
  if (viewModel.type === "BAR")
    return <BarVisualization viewModel={viewModel} />;
  return <LineVisualization viewModel={viewModel} />;
}
