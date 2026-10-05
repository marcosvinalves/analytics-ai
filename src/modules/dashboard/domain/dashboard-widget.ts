import {
  parseSemanticQuery,
  type SemanticQueryV1,
} from "../../query/domain/semantic-query.ts";
import {
  parseVisualizationSpec,
  type VisualizationSpecV1,
} from "./visualization-spec.ts";

export const MAX_DASHBOARD_WIDGETS = 12;

export type WidgetLayout = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type DashboardWidget = Readonly<{
  id: string;
  dashboardId: string;
  semanticModelId: string;
  semanticQuery: SemanticQueryV1;
  visualizationSpec: VisualizationSpecV1;
  layout: WidgetLayout;
  createdAt: Date;
  updatedAt: Date;
}>;

export type BrokenDashboardWidget = Readonly<{
  id: string;
  dashboardId: string;
  semanticModelId: string;
  layout: WidgetLayout | null;
  createdAt: Date;
  updatedAt: Date;
  reason:
    | "SEMANTIC_QUERY_INVALID"
    | "VISUALIZATION_SPEC_INVALID"
    | "LAYOUT_INVALID"
    | "WORKSPACE_RELATION_INVALID";
}>;

export type DashboardWidgetRead =
  | Readonly<{ configuration: "VALID"; widget: DashboardWidget }>
  | Readonly<{ configuration: "BROKEN"; widget: BrokenDashboardWidget }>;

export type DashboardWidgetScope = Readonly<{
  workspaceId: string;
  dashboardId: string;
  widgetId: string;
}>;

export type SaveDashboardWidgetInput = Readonly<{
  workspaceId: string;
  dashboardId: string;
  semanticModelId: string;
  semanticQuery: unknown;
  visualizationSpec: unknown;
  layout: WidgetLayout;
}>;

export type UpdateDashboardWidgetInput = SaveDashboardWidgetInput &
  Readonly<{ widgetId: string }>;

export type InvalidWidgetReason =
  "SEMANTIC_QUERY_INVALID" | "VISUALIZATION_SPEC_INVALID" | "LAYOUT_INVALID";

export type CreateDashboardWidgetResult =
  | { outcome: "CREATED"; widget: DashboardWidget }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INVALID_CONFIGURATION"; reason: InvalidWidgetReason }
  | { outcome: "LIMIT_REACHED" }
  | { outcome: "LAYOUT_CONFLICT" }
  | { outcome: "OPERATIONAL_FAILURE" }
  | { outcome: "OUTCOME_UNKNOWN" };

export type UpdateDashboardWidgetResult =
  | { outcome: "UPDATED"; widget: DashboardWidget }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INVALID_CONFIGURATION"; reason: InvalidWidgetReason }
  | { outcome: "LAYOUT_CONFLICT" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type GetDashboardWidgetResult =
  | { outcome: "FOUND"; widget: DashboardWidgetRead }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INCONSISTENT_PERSISTED_DATA" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type ListDashboardWidgetsResult =
  | { outcome: "LISTED"; widgets: DashboardWidgetRead[] }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INCONSISTENT_PERSISTED_DATA" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type DeleteDashboardWidgetResult =
  | { outcome: "DELETED" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" };

export type PreparedWidgetConfiguration = Readonly<{
  semanticQuery: SemanticQueryV1;
  semanticQueryJson: string;
  visualizationSpec: VisualizationSpecV1;
  visualizationSpecJson: string;
  layout: WidgetLayout;
}>;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function invalid(): never {
  throw new TypeError("Argumentos invalidos para DashboardWidget.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(","))
    invalid();
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function validWidgetLayout(value: unknown): value is WidgetLayout {
  if (!record(value)) return false;
  if (Object.keys(value).sort().join(",") !== "height,width,x,y") return false;
  const { x, y, width, height } = value;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    (x as number) >= 0 &&
    (x as number) <= 11 &&
    (y as number) >= 0 &&
    (width as number) >= 1 &&
    (width as number) <= 12 &&
    (height as number) >= 1 &&
    (x as number) + (width as number) <= 12 &&
    (y as number) + (height as number) <= 2147483647
  );
}

export function validateSaveDashboardWidgetInput(
  input: SaveDashboardWidgetInput | UpdateDashboardWidgetInput,
  update: boolean,
): void {
  if (!record(input)) invalid();
  const keys = [
    "workspaceId",
    "dashboardId",
    "semanticModelId",
    "semanticQuery",
    "visualizationSpec",
    "layout",
  ];
  if (update) keys.push("widgetId");
  exactKeys(input, keys);
  if (
    !uuid(input.workspaceId) ||
    !uuid(input.dashboardId) ||
    !uuid(input.semanticModelId) ||
    (update && !uuid((input as UpdateDashboardWidgetInput).widgetId))
  )
    invalid();
}

export function validateDashboardWidgetScope(
  input: DashboardWidgetScope,
): void {
  if (!record(input)) invalid();
  exactKeys(input, ["workspaceId", "dashboardId", "widgetId"]);
  if (
    !uuid(input.workspaceId) ||
    !uuid(input.dashboardId) ||
    !uuid(input.widgetId)
  )
    invalid();
}

export function validateDashboardWidgetsScope(input: {
  workspaceId: string;
  dashboardId: string;
}): void {
  if (!record(input)) invalid();
  exactKeys(input, ["workspaceId", "dashboardId"]);
  if (!uuid(input.workspaceId) || !uuid(input.dashboardId)) invalid();
}

export function prepareWidgetConfiguration(
  input: Pick<
    SaveDashboardWidgetInput,
    "semanticQuery" | "visualizationSpec" | "layout"
  >,
):
  | { valid: true; value: PreparedWidgetConfiguration }
  | { valid: false; reason: InvalidWidgetReason } {
  if (!validWidgetLayout(input.layout))
    return { valid: false, reason: "LAYOUT_INVALID" };
  const query = parseSemanticQuery(input.semanticQuery);
  if (!query.valid) return { valid: false, reason: "SEMANTIC_QUERY_INVALID" };
  const spec = parseVisualizationSpec(input.visualizationSpec);
  if (!spec.valid)
    return { valid: false, reason: "VISUALIZATION_SPEC_INVALID" };
  return {
    valid: true,
    value: {
      semanticQuery: query.query,
      semanticQueryJson: query.canonicalJson,
      visualizationSpec: spec.spec,
      visualizationSpecJson: spec.canonicalJson,
      layout: { ...input.layout },
    },
  };
}

export function rectanglesOverlap(a: WidgetLayout, b: WidgetLayout): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
