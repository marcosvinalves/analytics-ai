import type { SemanticType } from "./semantic-field.ts";
import type {
  InvalidExpression,
  MetricExpression,
} from "./metric-expression.ts";
import type { SemanticRevisionStatus } from "./semantic-model.ts";

export type MetricSnapshot = {
  id: string;
  metricKey: string;
  semanticModelRevisionId: string;
  name: string;
  label: string;
  description: string | null;
  expression: MetricExpression;
  resultType: SemanticType;
  createdAt: Date;
  updatedAt: Date;
};

export type MetricScope = {
  workspaceId: string;
  semanticModelRevisionId: string;
};

export type CreateMetricInput = MetricScope & {
  name: string;
  label: string;
  description?: string | null;
  expression: unknown;
};

export type UpdateMetricInput = MetricScope & {
  metricId: string;
  changes: {
    name?: string;
    label?: string;
    description?: string | null;
    expression?: unknown;
  };
};

export type RemoveMetricInput = MetricScope & { metricId: string };

type MutationFailure =
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "REVISION_NOT_EDITABLE";
      status: Exclude<SemanticRevisionStatus, "DRAFT">;
    }
  | { outcome: "INVALID_EXPRESSION"; error: InvalidExpression }
  | {
      outcome: "CONFLICT";
      reason: "NAME_ALREADY_EXISTS" | "METRIC_KEY_ALREADY_EXISTS";
    };

export type CreateMetricResult =
  { outcome: "CREATED"; metric: MetricSnapshot } | MutationFailure;

export type UpdateMetricResult =
  | { outcome: "UPDATED" | "UNCHANGED"; metric: MetricSnapshot }
  | MutationFailure;

export type RemoveMetricResult =
  | { outcome: "REMOVED" | "NOT_FOUND" }
  | {
      outcome: "REVISION_NOT_EDITABLE";
      status: Exclude<SemanticRevisionStatus, "DRAFT">;
    };

export type ListMetricsResult =
  | {
      outcome: "FOUND";
      revisionStatus: SemanticRevisionStatus;
      metrics: MetricSnapshot[];
    }
  | { outcome: "NOT_FOUND" };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

function invalid(): never {
  throw new TypeError("Argumentos invalidos para metrica.");
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function text(value: unknown, maximum: number, optional: boolean): void {
  if (optional && (value === undefined || value === null)) return;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum
  )
    invalid();
}

function scope(input: MetricScope): void {
  if (
    !input ||
    typeof input !== "object" ||
    !uuid(input.workspaceId) ||
    !uuid(input.semanticModelRevisionId)
  )
    invalid();
}

export function validateCreateMetricInput(input: CreateMetricInput): void {
  scope(input);
  const allowed = new Set([
    "workspaceId",
    "semanticModelRevisionId",
    "name",
    "label",
    "description",
    "expression",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid();
  if (typeof input.name !== "string" || !NAME.test(input.name)) invalid();
  text(input.label, 200, false);
  text(input.description, 2000, true);
  if (!("expression" in input)) invalid();
}

export function validateUpdateMetricInput(input: UpdateMetricInput): void {
  scope(input);
  if (
    !uuid(input.metricId) ||
    !input.changes ||
    typeof input.changes !== "object"
  )
    invalid();
  const keys = Object.keys(input.changes);
  const allowed = new Set(["name", "label", "description", "expression"]);
  if (!keys.length || keys.some((key) => !allowed.has(key))) invalid();
  if (input.changes.name !== undefined && !NAME.test(input.changes.name))
    invalid();
  if (input.changes.label !== undefined) text(input.changes.label, 200, false);
  if ("description" in input.changes)
    text(input.changes.description, 2000, true);
}

export function validateRemoveMetricInput(input: RemoveMetricInput): void {
  scope(input);
  if (!uuid(input.metricId)) invalid();
}

export function validateListMetricsInput(input: MetricScope): void {
  scope(input);
}
