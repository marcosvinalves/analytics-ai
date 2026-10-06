"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { BarChartDatum } from "./chart-data";
import styles from "./visualizations.module.css";

function tooltip({ active, payload }: TooltipContentProps) {
  const datum = payload?.[0]?.payload as BarChartDatum | undefined;
  if (!active || !datum) return null;
  return (
    <div className={styles.tooltip} role="status">
      <strong>{datum.accessibleCategory}</strong>
      <span>
        {datum.exactness === "APPROXIMATE" ? "≈ " : ""}
        {datum.accessibleValue}
      </span>
    </div>
  );
}

export function BarChartClient({
  data,
  categoryLabel,
  valueLabel,
}: Readonly<{
  data: readonly BarChartDatum[];
  categoryLabel: string;
  valueLabel: string;
}>) {
  const height = Math.max(240, data.length * 32);
  return (
    <div className={styles.chartScroll} data-chart-type="BAR">
      <div style={{ height }}>
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 720, height: Math.min(height, 480) }}
        >
          <BarChart
            data={[...data]}
            layout="vertical"
            accessibilityLayer
            margin={{ top: 8, right: 24, bottom: 24, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" aria-label={valueLabel} />
            <YAxis
              type="category"
              dataKey="categoryLabel"
              width={160}
              interval={0}
              aria-label={categoryLabel}
            />
            <Tooltip content={tooltip} isAnimationActive="auto" />
            <Bar
              dataKey="geometryValue"
              name={valueLabel}
              fill="var(--visualization-primary)"
              isAnimationActive="auto"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
