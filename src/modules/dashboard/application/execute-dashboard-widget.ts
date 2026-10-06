import "server-only";

import type { Pool } from "pg";
import {
  mapVisualization,
  type VisualizationViewModel,
} from "../domain/visualization-mapping.ts";
import {
  validateDashboardWidgetScope,
  type BrokenDashboardWidget,
  type DashboardWidgetScope,
} from "../domain/dashboard-widget.ts";
import { getDashboardWidget } from "../infrastructure/dashboard-widgets.ts";
import {
  runSemanticQuery,
  type RunSemanticQueryResult,
} from "../../query/application/run-semantic-query.ts";
import type { QueryExplanation } from "../../query/domain/query-explanation.ts";

export type WidgetBrokenReason =
  BrokenDashboardWidget["reason"] | "VISUALIZATION_INCOMPATIBLE";

export type WidgetExecutionErrorReason =
  | "MODEL_NOT_PUBLISHED"
  | "DATA_NOT_READY"
  | "QUERY_NOT_SUPPORTED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_INCONSISTENT"
  | "QUERY_EXECUTION_FAILED"
  | "QUERY_TIMEOUT"
  | "RESULT_LIMIT_EXCEEDED"
  | "RESULT_TOO_LARGE"
  | "INCONSISTENT_WIDGET_METADATA"
  | "INCONSISTENT_QUERY_PIPELINE"
  | "OPERATIONAL_FAILURE";

type CompletedWidgetExecution = Readonly<{
  widgetId: string;
  viewModel: VisualizationViewModel;
  explanation: QueryExplanation;
}>;

export type ExecuteDashboardWidgetResult =
  | (Readonly<{ status: "SUCCESS" }> & CompletedWidgetExecution)
  | (Readonly<{ status: "EMPTY" }> & CompletedWidgetExecution)
  | Readonly<{
      status: "BROKEN";
      widgetId: string;
      reason: WidgetBrokenReason;
    }>
  | Readonly<{ status: "NOT_FOUND" }>
  | Readonly<{
      status: "ERROR";
      widgetId: string;
      reason: Exclude<WidgetExecutionErrorReason, "DATA_NOT_READY">;
    }>
  | Readonly<{
      status: "ERROR";
      widgetId: string;
      reason: "DATA_NOT_READY";
      dataStatus: "PROCESSING" | "FAILED";
    }>
  | Readonly<{ status: "CANCELLED"; widgetId: string }>;

export type ExecuteDashboardWidgetOptions = Readonly<{
  signal?: AbortSignal;
}>;

function error(
  widgetId: string,
  reason: Exclude<WidgetExecutionErrorReason, "DATA_NOT_READY">,
): ExecuteDashboardWidgetResult {
  return { status: "ERROR", widgetId, reason };
}

function empty(viewModel: VisualizationViewModel): boolean {
  if (viewModel.type === "KPI") return viewModel.state === "EMPTY";
  if (viewModel.type === "TABLE") return viewModel.rows.length === 0;
  return viewModel.points.length === 0;
}

function mapQueryFailure(
  widgetId: string,
  result: Exclude<RunSemanticQueryResult, { outcome: "SUCCESS" }>,
): ExecuteDashboardWidgetResult {
  if (result.outcome === "QUERY_CANCELLED")
    return { status: "CANCELLED", widgetId };
  if (result.outcome === "DATA_NOT_READY")
    return {
      status: "ERROR",
      widgetId,
      reason: "DATA_NOT_READY",
      dataStatus: result.status,
    };
  if (
    result.outcome === "INVALID_QUERY" ||
    result.outcome === "MODEL_NOT_FOUND" ||
    result.outcome === "INCONSISTENT_QUERY_PIPELINE"
  )
    return error(widgetId, "INCONSISTENT_QUERY_PIPELINE");
  return error(widgetId, result.outcome);
}

/**
 * Executes one persisted widget. Workspace scope is mandatory metadata
 * isolation; the caller remains responsible for authentication/authorization.
 */
export async function executeDashboardWidget(
  pool: Pool,
  input: DashboardWidgetScope,
  options: ExecuteDashboardWidgetOptions = {},
): Promise<ExecuteDashboardWidgetResult> {
  validateDashboardWidgetScope(input);
  if (options.signal?.aborted)
    return { status: "CANCELLED", widgetId: input.widgetId };

  const stored = await getDashboardWidget(pool, input);
  if (stored.outcome === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (stored.outcome === "OPERATIONAL_FAILURE")
    return error(input.widgetId, "OPERATIONAL_FAILURE");
  if (stored.outcome === "INCONSISTENT_PERSISTED_DATA")
    return error(input.widgetId, "INCONSISTENT_WIDGET_METADATA");
  if (stored.widget.configuration === "BROKEN")
    return {
      status: "BROKEN",
      widgetId: stored.widget.widget.id,
      reason: stored.widget.widget.reason,
    };

  if (options.signal?.aborted)
    return { status: "CANCELLED", widgetId: input.widgetId };

  const widget = stored.widget.widget;
  let queried: RunSemanticQueryResult;
  try {
    queried = await runSemanticQuery(
      pool,
      {
        workspaceId: input.workspaceId,
        semanticModelId: widget.semanticModelId,
        query: widget.semanticQuery,
      },
      { signal: options.signal },
    );
  } catch {
    return options.signal?.aborted
      ? { status: "CANCELLED", widgetId: widget.id }
      : error(widget.id, "OPERATIONAL_FAILURE");
  }
  if (queried.outcome !== "SUCCESS") return mapQueryFailure(widget.id, queried);

  try {
    const mapped = mapVisualization(
      widget.visualizationSpec,
      queried.execution.result,
      queried.execution.explanation.orderBy,
    );
    if (mapped.outcome === "INCOMPATIBLE")
      return {
        status: "BROKEN",
        widgetId: widget.id,
        reason: "VISUALIZATION_INCOMPATIBLE",
      };
    if (mapped.outcome === "INVALID_RESULT")
      return error(widget.id, "INCONSISTENT_QUERY_PIPELINE");
    return {
      status: empty(mapped.viewModel) ? "EMPTY" : "SUCCESS",
      widgetId: widget.id,
      viewModel: mapped.viewModel,
      explanation: queried.execution.explanation,
    };
  } catch {
    return error(widget.id, "INCONSISTENT_QUERY_PIPELINE");
  }
}
