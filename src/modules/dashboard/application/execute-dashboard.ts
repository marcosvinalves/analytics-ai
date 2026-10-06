import "server-only";

import type { Pool } from "pg";
import {
  executeDashboardWidget,
  type ExecuteDashboardWidgetResult,
} from "./execute-dashboard-widget.ts";
import {
  validateDashboardWidgetsScope,
  type DashboardWidgetRead,
  type WidgetLayout,
} from "../domain/dashboard-widget.ts";
import { listDashboardWidgets } from "../infrastructure/dashboard-widgets.ts";

const MAX_CONCURRENT_WIDGETS = 2;

export type DashboardExecutionItem = Readonly<{
  widgetId: string;
  layout: WidgetLayout | null;
  result: ExecuteDashboardWidgetResult;
}>;

export type ExecuteDashboardResult =
  | Readonly<{
      status: "COMPLETED" | "CANCELLED";
      dashboardId: string;
      widgets: readonly DashboardExecutionItem[];
    }>
  | Readonly<{ status: "NOT_FOUND" }>
  | Readonly<{
      status: "OPERATIONAL_FAILURE";
      reason: "READ_FAILED" | "INCONSISTENT_DASHBOARD_METADATA";
    }>;

export type ExecuteDashboardOptions = Readonly<{ signal?: AbortSignal }>;

type DiscoveredWidget = Readonly<{
  widgetId: string;
  layout: WidgetLayout | null;
}>;

function discovered(value: DashboardWidgetRead): DiscoveredWidget {
  return {
    widgetId: value.widget.id,
    layout: value.widget.layout,
  };
}

function cancelled(value: DiscoveredWidget): DashboardExecutionItem {
  return {
    ...value,
    result: { status: "CANCELLED", widgetId: value.widgetId },
  };
}

/**
 * Executes the widgets discovered for one workspace-scoped Dashboard.
 * The two-worker limit is local to this invocation.
 */
export async function executeDashboard(
  pool: Pool,
  input: { workspaceId: string; dashboardId: string },
  options: ExecuteDashboardOptions = {},
): Promise<ExecuteDashboardResult> {
  validateDashboardWidgetsScope(input);
  if (options.signal?.aborted)
    return { status: "CANCELLED", dashboardId: input.dashboardId, widgets: [] };

  let listed: Awaited<ReturnType<typeof listDashboardWidgets>>;
  try {
    listed = await listDashboardWidgets(pool, input);
  } catch {
    return { status: "OPERATIONAL_FAILURE", reason: "READ_FAILED" };
  }
  if (listed.outcome === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (listed.outcome === "OPERATIONAL_FAILURE")
    return { status: "OPERATIONAL_FAILURE", reason: "READ_FAILED" };
  if (listed.outcome === "INCONSISTENT_PERSISTED_DATA")
    return {
      status: "OPERATIONAL_FAILURE",
      reason: "INCONSISTENT_DASHBOARD_METADATA",
    };

  const widgets = listed.widgets.map(discovered);
  if (options.signal?.aborted)
    return {
      status: "CANCELLED",
      dashboardId: input.dashboardId,
      widgets: widgets.map(cancelled),
    };

  const results = new Array<DashboardExecutionItem | undefined>(widgets.length);
  let nextIndex = 0;
  let cancellationObserved = false;

  async function worker(): Promise<void> {
    while (true) {
      if (options.signal?.aborted) {
        cancellationObserved = true;
        return;
      }
      const index = nextIndex++;
      if (index >= widgets.length) return;
      const widget = widgets[index];
      let result: ExecuteDashboardWidgetResult;
      try {
        result = await executeDashboardWidget(
          pool,
          {
            workspaceId: input.workspaceId,
            dashboardId: input.dashboardId,
            widgetId: widget.widgetId,
          },
          { signal: options.signal },
        );
      } catch {
        result = {
          status: "ERROR",
          widgetId: widget.widgetId,
          reason: "OPERATIONAL_FAILURE",
        };
      }
      results[index] = { ...widget, result };
      if (options.signal?.aborted) cancellationObserved = true;
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_WIDGETS, widgets.length) },
      () => worker(),
    ),
  );

  for (let index = 0; index < widgets.length; index += 1)
    results[index] ??= cancelled(widgets[index]);

  return {
    status:
      cancellationObserved || options.signal?.aborted
        ? "CANCELLED"
        : "COMPLETED",
    dashboardId: input.dashboardId,
    widgets: results as DashboardExecutionItem[],
  };
}
