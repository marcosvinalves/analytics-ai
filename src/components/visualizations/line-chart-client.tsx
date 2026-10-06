"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { LineChartDatum } from "./chart-data";
import styles from "./visualizations.module.css";

function tooltip({ active, payload }: TooltipContentProps) {
  const datum = payload?.[0]?.payload as LineChartDatum | undefined;
  if (!active || !datum) return null;
  return (
    <div className={styles.tooltip} role="status">
      <strong>{datum.accessibleX}</strong>
      <span>
        {datum.exactness === "APPROXIMATE" ? "≈ " : ""}
        {datum.accessibleValue}
      </span>
    </div>
  );
}

export function LineChartClient({
  data,
  xLabel,
  yLabel,
}: Readonly<{
  data: readonly LineChartDatum[];
  xLabel: string;
  yLabel: string;
}>) {
  return (
    <div className={styles.lineChart} data-chart-type="LINE">
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 720, height: 320 }}
      >
        <LineChart
          data={[...data]}
          accessibilityLayer
          margin={{ top: 16, right: 24, bottom: 24, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="xLabel"
            type="category"
            allowDuplicatedCategory
            interval="preserveStartEnd"
            aria-label={xLabel}
          />
          <YAxis aria-label={yLabel} />
          <Tooltip content={tooltip} isAnimationActive="auto" />
          <Line
            dataKey="geometryValue"
            name={yLabel}
            stroke="var(--visualization-primary)"
            strokeWidth={2}
            connectNulls={false}
            dot={data.length <= 50}
            activeDot={{ r: 5 }}
            isAnimationActive="auto"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
