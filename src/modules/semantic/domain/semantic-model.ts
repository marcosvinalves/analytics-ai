export type DatasetVersionStatus = "PROCESSING" | "READY" | "FAILED";
export type SemanticRevisionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export type CreateSemanticModelDraftInput = {
  workspaceId: string;
  datasetId: string;
  datasetVersionId: string;
  modelName: string;
  label: string;
  description?: string | null;
};

export type SemanticModelSnapshot = {
  id: string;
  datasetId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SemanticModelRevisionSnapshot = {
  id: string;
  semanticModelId: string;
  datasetVersionId: string;
  revisionNumber: number;
  status: SemanticRevisionStatus;
  label: string;
  description: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSemanticModelDraftResult =
  | {
      outcome: "CREATED" | "EXISTING";
      model: SemanticModelSnapshot;
      revision: SemanticModelRevisionSnapshot;
    }
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "VERSION_NOT_READY";
      status: "PROCESSING" | "FAILED";
    }
  | {
      outcome: "CONFLICT";
      reason: "MODEL_NAME_MISMATCH" | "DRAFT_ALREADY_EXISTS";
    };

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MODEL_NAME = /^[a-z][a-z0-9_]{0,62}$/;

function invalid(): never {
  throw new TypeError("Argumentos invalidos para criar o draft semantico.");
}

export function normalizedDescription(
  description: string | null | undefined,
): string | null {
  return description ?? null;
}

export function validateCreateSemanticModelDraftInput(
  input: CreateSemanticModelDraftInput,
): void {
  if (!input || typeof input !== "object") invalid();
  for (const value of [
    input.workspaceId,
    input.datasetId,
    input.datasetVersionId,
  ]) {
    if (typeof value !== "string" || !UUID.test(value)) invalid();
  }
  if (typeof input.modelName !== "string" || !MODEL_NAME.test(input.modelName))
    invalid();
  if (
    typeof input.label !== "string" ||
    input.label !== input.label.trim() ||
    input.label.length < 1 ||
    input.label.length > 200
  )
    invalid();
  if (
    input.description !== undefined &&
    input.description !== null &&
    (typeof input.description !== "string" ||
      input.description !== input.description.trim() ||
      input.description.length < 1 ||
      input.description.length > 2000)
  )
    invalid();
}
