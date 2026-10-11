import type {
  DatasetVersionStatus,
  SemanticRevisionStatus,
} from "./semantic-model.ts";

export type SemanticOnboardingScope = {
  workspaceId: string;
  datasetId: string;
  datasetVersionId: string;
};

export type SemanticOnboardingDataset = {
  id: string;
  name: string;
  selectedVersion: {
    id: string;
    versionNumber: number;
    status: DatasetVersionStatus;
  };
};

export type SemanticOnboardingRevision = {
  id: string;
  revisionNumber: number;
  status: SemanticRevisionStatus;
  label: string;
  datasetVersion: { id: string; versionNumber: number };
};

type AvailableBase = {
  dataset: SemanticOnboardingDataset;
};

export type SemanticOnboardingReadiness =
  | { outcome: "NOT_FOUND" }
  | { outcome: "OPERATIONAL_FAILURE" }
  | (AvailableBase & {
      outcome: "DATASET_NOT_READY";
      status: "PROCESSING" | "FAILED";
    })
  | (AvailableBase & { outcome: "CAN_CREATE_DRAFT" })
  | (AvailableBase & {
      outcome: "DRAFT_AVAILABLE";
      model: { id: string; name: string };
      draft: SemanticOnboardingRevision & { status: "DRAFT" };
      published: SemanticOnboardingRevision | null;
    })
  | (AvailableBase & {
      outcome: "PUBLISHED_ONLY";
      model: { id: string; name: string };
      published: SemanticOnboardingRevision & { status: "PUBLISHED" };
    })
  | (AvailableBase & {
      outcome: "BROKEN";
      message: string;
    });

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function validateSemanticOnboardingScope(
  input: SemanticOnboardingScope,
): void {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !==
      ["datasetId", "datasetVersionId", "workspaceId"].sort().join(",") ||
    !UUID.test(input.workspaceId) ||
    !UUID.test(input.datasetId) ||
    !UUID.test(input.datasetVersionId)
  )
    throw new TypeError("Argumentos inválidos para readiness semântico.");
}

export function initialSemanticModelName(datasetId: string): string {
  if (!UUID.test(datasetId))
    throw new TypeError("Dataset inválido para modelo semântico.");
  return `dataset_${datasetId.replaceAll("-", "").toLowerCase()}`;
}
