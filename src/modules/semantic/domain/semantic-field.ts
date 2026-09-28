import {
  parsePhysicalType,
  type PhysicalType,
} from "../../dataset/domain/physical-type.ts";
import type { SemanticRevisionStatus } from "./semantic-model.ts";
import type { InvalidExpression } from "./metric-expression.ts";

export type SemanticType =
  | { kind: "STRING" }
  | { kind: "BOOLEAN" }
  | { kind: "INTEGER" }
  | { kind: "NUMBER" }
  | { kind: "DATE" }
  | { kind: "DATETIME" }
  | { kind: "INSTANT" }
  | { kind: "DECIMAL"; precision: number; scale: number };

export type TypeCompatibility = "SAFE" | "EXPLICIT" | "INVALID";
export type CompatibilityResult = {
  compatibility: TypeCompatibility;
  reason:
    | "DIRECT"
    | "EXACT_NUMERIC_CONVERSION"
    | "APPROXIMATE_NUMERIC_CONVERSION"
    | "ORIGINAL_DECIMAL_NOT_RECOVERABLE"
    | "TEXTUAL_UUID"
    | "UNSUPPORTED_PHYSICAL_TYPE"
    | "INCOMPATIBLE_TYPES"
    | "INSUFFICIENT_DECIMAL_ENVELOPE";
};

export type SemanticFieldSnapshot = {
  id: string;
  fieldKey: string;
  semanticModelRevisionId: string;
  datasetVersionId: string;
  datasetColumnId: string;
  physicalName: string;
  physicalType: string;
  ordinalPosition: number;
  name: string;
  label: string;
  description: string | null;
  semanticType: SemanticType;
  compatibility: CompatibilityResult;
  createdAt: Date;
  updatedAt: Date;
};

export type SemanticFieldScope = {
  workspaceId: string;
  semanticModelRevisionId: string;
};

export type CreateSemanticFieldInput = SemanticFieldScope & {
  datasetColumnId: string;
  name: string;
  label: string;
  description?: string | null;
  semanticType: SemanticType;
  acceptExplicitConversion?: boolean;
};

export type UpdateSemanticFieldInput = SemanticFieldScope & {
  semanticFieldId: string;
  changes: {
    datasetColumnId?: string;
    name?: string;
    label?: string;
    description?: string | null;
    semanticType?: SemanticType;
    acceptExplicitConversion?: boolean;
  };
};

export type RemoveSemanticFieldInput = SemanticFieldScope & {
  semanticFieldId: string;
};

export type SemanticFieldConflict =
  | "FIELD_KEY_ALREADY_EXISTS"
  | "NAME_ALREADY_EXISTS"
  | "DATASET_COLUMN_ALREADY_MAPPED";

type FieldMutationFailure =
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "REVISION_NOT_EDITABLE";
      status: Exclude<SemanticRevisionStatus, "DRAFT">;
    }
  | {
      outcome: "EXPLICIT_CONVERSION_REQUIRED";
      compatibility: CompatibilityResult;
    }
  | {
      outcome: "INCOMPATIBLE_TYPE";
      compatibility: CompatibilityResult;
    }
  | { outcome: "CONFLICT"; reason: SemanticFieldConflict };

export type CreateSemanticFieldResult =
  | {
      outcome: "CREATED";
      field: SemanticFieldSnapshot;
    }
  | FieldMutationFailure;

export type UpdateSemanticFieldResult =
  | {
      outcome: "UPDATED" | "UNCHANGED";
      field: SemanticFieldSnapshot;
    }
  | {
      outcome: "FIELD_CHANGE_INVALIDATES_METRIC";
      metricKey: string;
      error: InvalidExpression;
    }
  | FieldMutationFailure;

export type RemoveSemanticFieldResult =
  | { outcome: "REMOVED" }
  | { outcome: "NOT_FOUND" }
  | { outcome: "FIELD_IN_USE"; metricKey: string }
  | {
      outcome: "REVISION_NOT_EDITABLE";
      status: Exclude<SemanticRevisionStatus, "DRAFT">;
    };

export type ListSemanticFieldsResult =
  | {
      outcome: "FOUND";
      revisionStatus: SemanticRevisionStatus;
      fields: SemanticFieldSnapshot[];
    }
  | { outcome: "NOT_FOUND" };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SIMPLE_SEMANTIC_TYPES = new Set([
  "STRING",
  "BOOLEAN",
  "INTEGER",
  "NUMBER",
  "DATE",
  "DATETIME",
  "INSTANT",
]);

function invalid(): never {
  throw new TypeError("Argumentos invalidos para campo semantico.");
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validateScope(input: SemanticFieldScope): void {
  if (
    !input ||
    typeof input !== "object" ||
    !validUuid(input.workspaceId) ||
    !validUuid(input.semanticModelRevisionId)
  )
    invalid();
}

function validateText(
  value: unknown,
  maximum: number,
  optional: boolean,
): void {
  if (optional && (value === undefined || value === null)) return;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > maximum
  )
    invalid();
}

export function validateSemanticType(value: SemanticType): void {
  if (!value || typeof value !== "object" || typeof value.kind !== "string")
    invalid();
  const keys = Object.keys(value).sort();
  if (value.kind === "DECIMAL") {
    if (
      keys.join(",") !== "kind,precision,scale" ||
      !Number.isInteger(value.precision) ||
      value.precision < 1 ||
      value.precision > 38 ||
      !Number.isInteger(value.scale) ||
      value.scale < 0 ||
      value.scale > value.precision
    )
      invalid();
    return;
  }
  if (!SIMPLE_SEMANTIC_TYPES.has(value.kind) || keys.join(",") !== "kind")
    invalid();
}

function decimalContains(
  target: Extract<SemanticType, { kind: "DECIMAL" }>,
  sourcePrecision: number,
  sourceScale: number,
): boolean {
  return (
    target.scale >= sourceScale &&
    target.precision - target.scale >= sourcePrecision - sourceScale
  );
}

function classifyKnownType(
  physical: PhysicalType,
  semantic: SemanticType,
): CompatibilityResult {
  if (
    (physical.family === "STRING" && semantic.kind === "STRING") ||
    (physical.family === "BOOLEAN" && semantic.kind === "BOOLEAN") ||
    (physical.family === "INTEGER" && semantic.kind === "INTEGER") ||
    (physical.family === "NUMBER" && semantic.kind === "NUMBER") ||
    (physical.family === "DATE" && semantic.kind === "DATE") ||
    (physical.family === "DATETIME" && semantic.kind === "DATETIME") ||
    (physical.family === "INSTANT" && semantic.kind === "INSTANT")
  )
    return { compatibility: "SAFE", reason: "DIRECT" };

  if (physical.family === "INTEGER" && semantic.kind === "DECIMAL") {
    if (semantic.precision - semantic.scale < physical.decimalDigits)
      return {
        compatibility: "INVALID",
        reason: "INSUFFICIENT_DECIMAL_ENVELOPE",
      };
    return {
      compatibility: "EXPLICIT",
      reason: "EXACT_NUMERIC_CONVERSION",
    };
  }
  if (physical.family === "INTEGER" && semantic.kind === "NUMBER")
    return {
      compatibility: "EXPLICIT",
      reason: "APPROXIMATE_NUMERIC_CONVERSION",
    };
  if (physical.family === "NUMBER" && semantic.kind === "DECIMAL")
    return {
      compatibility: "EXPLICIT",
      reason: "ORIGINAL_DECIMAL_NOT_RECOVERABLE",
    };
  if (physical.family === "DECIMAL" && semantic.kind === "DECIMAL")
    return decimalContains(semantic, physical.precision, physical.scale)
      ? { compatibility: "SAFE", reason: "DIRECT" }
      : {
          compatibility: "INVALID",
          reason: "INSUFFICIENT_DECIMAL_ENVELOPE",
        };
  if (
    physical.family === "DECIMAL" &&
    physical.scale === 0 &&
    semantic.kind === "INTEGER"
  )
    return { compatibility: "SAFE", reason: "DIRECT" };
  if (physical.family === "DECIMAL" && semantic.kind === "NUMBER")
    return {
      compatibility: "EXPLICIT",
      reason: "APPROXIMATE_NUMERIC_CONVERSION",
    };
  if (physical.family === "UUID" && semantic.kind === "STRING")
    return { compatibility: "EXPLICIT", reason: "TEXTUAL_UUID" };
  return { compatibility: "INVALID", reason: "INCOMPATIBLE_TYPES" };
}

/** Admissibility of semantic intent only; it does not prove an execution strategy exists. */
export function classifyTypeCompatibility(
  physicalType: string,
  semanticType: SemanticType,
): CompatibilityResult {
  validateSemanticType(semanticType);
  const physical = parsePhysicalType(physicalType);
  if (!physical)
    return {
      compatibility: "INVALID",
      reason: "UNSUPPORTED_PHYSICAL_TYPE",
    };
  return classifyKnownType(physical, semanticType);
}

export function validateCreateSemanticFieldInput(
  input: CreateSemanticFieldInput,
): void {
  validateScope(input);
  const keys = new Set(Object.keys(input));
  for (const key of [
    "workspaceId",
    "semanticModelRevisionId",
    "datasetColumnId",
    "name",
    "label",
    "description",
    "semanticType",
    "acceptExplicitConversion",
  ])
    keys.delete(key);
  if (keys.size || !validUuid(input.datasetColumnId)) invalid();
  if (typeof input.name !== "string" || !FIELD_NAME.test(input.name)) invalid();
  validateText(input.label, 200, false);
  validateText(input.description, 2000, true);
  validateSemanticType(input.semanticType);
  if (
    input.acceptExplicitConversion !== undefined &&
    typeof input.acceptExplicitConversion !== "boolean"
  )
    invalid();
}

export function validateUpdateSemanticFieldInput(
  input: UpdateSemanticFieldInput,
): void {
  validateScope(input);
  if (
    !validUuid(input.semanticFieldId) ||
    !input.changes ||
    typeof input.changes !== "object"
  )
    invalid();
  const keys = Object.keys(input.changes);
  const allowed = new Set([
    "datasetColumnId",
    "name",
    "label",
    "description",
    "semanticType",
    "acceptExplicitConversion",
  ]);
  if (!keys.length || keys.some((key) => !allowed.has(key))) invalid();
  const changes = input.changes;
  if (
    changes.datasetColumnId !== undefined &&
    !validUuid(changes.datasetColumnId)
  )
    invalid();
  if (changes.name !== undefined && !FIELD_NAME.test(changes.name)) invalid();
  if (changes.label !== undefined) validateText(changes.label, 200, false);
  if ("description" in changes) validateText(changes.description, 2000, true);
  if (changes.semanticType !== undefined)
    validateSemanticType(changes.semanticType);
  if (
    changes.acceptExplicitConversion !== undefined &&
    typeof changes.acceptExplicitConversion !== "boolean"
  )
    invalid();
  if (keys.every((key) => key === "acceptExplicitConversion")) invalid();
}

export function validateRemoveSemanticFieldInput(
  input: RemoveSemanticFieldInput,
): void {
  validateScope(input);
  if (!validUuid(input.semanticFieldId)) invalid();
}

export function validateListSemanticFieldsInput(
  input: SemanticFieldScope,
): void {
  validateScope(input);
}

export function semanticTypeFromStorage(
  kind: string,
  precision: number | null,
  scale: number | null,
): SemanticType {
  const value =
    kind === "DECIMAL"
      ? { kind, precision, scale }
      : { kind, precision: undefined, scale: undefined };
  if (kind === "DECIMAL") {
    validateSemanticType(value as SemanticType);
    return value as SemanticType;
  }
  const simple = { kind } as SemanticType;
  validateSemanticType(simple);
  if (precision !== null || scale !== null) invalid();
  return simple;
}
