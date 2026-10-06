import type {
  BarViewModel,
  LineViewModel,
} from "@/modules/dashboard/domain/visualization-mapping";
import {
  formatCategoricalVisualizationValue,
  formatNumericVisualizationValue,
  formatTemporalVisualizationValue,
} from "./format-visualization-value";

export type ChartNumericDatum = Readonly<{
  authoritativeValue: string | null;
  formattedValue: string;
  accessibleValue: string;
  exactness: "EXACT" | "APPROXIMATE" | null;
  geometryValue: number | null;
}>;

export type BarChartDatum = ChartNumericDatum &
  Readonly<{
    index: number;
    category: string | null;
    categoryLabel: string;
    accessibleCategory: string;
  }>;

export type LineChartDatum = ChartNumericDatum &
  Readonly<{
    index: number;
    x: string | null;
    xLabel: string;
    accessibleX: string;
  }>;

function numericDatum(
  value: BarViewModel["points"][number]["value"],
): ChartNumericDatum {
  const formatted = formatNumericVisualizationValue(value);
  return {
    authoritativeValue: value.type === "NULL" ? null : value.value,
    formattedValue: formatted.text,
    accessibleValue: formatted.accessibleText,
    exactness: value.type === "NULL" ? null : value.exactness,
    geometryValue:
      value.type === "NULL" || value.geometryValue === undefined
        ? null
        : value.geometryValue,
  };
}

export function toBarChartData(
  viewModel: BarViewModel,
): readonly BarChartDatum[] {
  return viewModel.points.map((point, index) => {
    const category = formatCategoricalVisualizationValue(point.category);
    return {
      index,
      category:
        point.category.type === "NULL" ? null : String(point.category.value),
      categoryLabel: category.text,
      accessibleCategory: category.accessibleText,
      ...numericDatum(point.value),
    };
  });
}

export function toLineChartData(
  viewModel: LineViewModel,
): readonly LineChartDatum[] {
  return viewModel.points.map((point, index) => {
    const x = formatTemporalVisualizationValue(point.x);
    return {
      index,
      x: point.x.type === "NULL" ? null : point.x.value,
      xLabel: x.text,
      accessibleX: x.accessibleText,
      ...numericDatum(point.y),
    };
  });
}
