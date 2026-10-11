import type { Pool, PoolClient } from "pg";
import {
  validateSemanticOnboardingScope,
  type SemanticOnboardingDataset,
  type SemanticOnboardingReadiness,
  type SemanticOnboardingRevision,
  type SemanticOnboardingScope,
} from "../domain/semantic-onboarding.ts";
import type {
  DatasetVersionStatus,
  SemanticRevisionStatus,
} from "../domain/semantic-model.ts";
import { inspectPublishedSemanticModelSnapshot } from "./semantic-inspection.ts";

type Row = {
  dataset_id: string;
  dataset_name: string;
  selected_version_id: string;
  selected_version_number: number;
  selected_version_status: DatasetVersionStatus;
  model_id: string | null;
  model_name: string | null;
  draft_id: string | null;
  draft_number: number | null;
  draft_status: SemanticRevisionStatus | null;
  draft_label: string | null;
  draft_version_id: string | null;
  draft_version_number: number | null;
  draft_dataset_id: string | null;
  published_id: string | null;
  published_number: number | null;
  published_status: SemanticRevisionStatus | null;
  published_label: string | null;
  published_version_id: string | null;
  published_version_number: number | null;
  published_dataset_id: string | null;
};

const brokenMessage =
  "A configuração semântica não pôde ser lida com segurança.";

function dataset(row: Row): SemanticOnboardingDataset {
  return {
    id: row.dataset_id,
    name: row.dataset_name,
    selectedVersion: {
      id: row.selected_version_id,
      versionNumber: row.selected_version_number,
      status: row.selected_version_status,
    },
  };
}

function revision(
  row: Row,
  kind: "draft" | "published",
): SemanticOnboardingRevision | null {
  const id = row[`${kind}_id`];
  const revisionNumber = row[`${kind}_number`];
  const status = row[`${kind}_status`];
  const label = row[`${kind}_label`];
  const versionId = row[`${kind}_version_id`];
  const versionNumber = row[`${kind}_version_number`];
  if (id === null) return null;
  if (
    revisionNumber === null ||
    status === null ||
    label === null ||
    versionId === null ||
    versionNumber === null
  )
    throw new Error("SEMANTIC_ONBOARDING_INCOMPLETE_REVISION");
  return {
    id,
    revisionNumber,
    status,
    label,
    datasetVersion: { id: versionId, versionNumber },
  };
}

async function readRow(client: PoolClient, input: SemanticOnboardingScope) {
  return (
    await client.query<Row>(
      `/* semantic-onboarding:readiness */
       SELECT d.id AS dataset_id, d.name AS dataset_name,
         selected.id AS selected_version_id,
         selected.version_number AS selected_version_number,
         selected.status AS selected_version_status,
         model.id AS model_id, model.name AS model_name,
         draft.id AS draft_id, draft.revision_number AS draft_number,
         draft.status AS draft_status, draft.label AS draft_label,
         draft_version.id AS draft_version_id,
         draft_version.version_number AS draft_version_number,
         draft_version.dataset_id AS draft_dataset_id,
         published.id AS published_id,
         published.revision_number AS published_number,
         published.status AS published_status,
         published.label AS published_label,
         published_version.id AS published_version_id,
         published_version.version_number AS published_version_number,
         published_version.dataset_id AS published_dataset_id
       FROM app.datasets d
       JOIN app.dataset_versions selected
         ON selected.dataset_id = d.id AND selected.id = $3
       LEFT JOIN app.semantic_models model ON model.dataset_id = d.id
       LEFT JOIN app.semantic_model_revisions draft
         ON draft.semantic_model_id = model.id AND draft.status = 'DRAFT'
       LEFT JOIN app.dataset_versions draft_version
         ON draft_version.id = draft.dataset_version_id
       LEFT JOIN app.semantic_model_revisions published
         ON published.semantic_model_id = model.id AND published.status = 'PUBLISHED'
       LEFT JOIN app.dataset_versions published_version
         ON published_version.id = published.dataset_version_id
       WHERE d.id = $1 AND d.workspace_id = $2`,
      [input.datasetId, input.workspaceId, input.datasetVersionId],
    )
  ).rows[0];
}

export async function readSemanticOnboardingReadiness(
  pool: Pool,
  input: SemanticOnboardingScope,
): Promise<SemanticOnboardingReadiness> {
  validateSemanticOnboardingScope(input);
  const client = await pool.connect().catch(() => undefined);
  if (!client) return { outcome: "OPERATIONAL_FAILURE" };
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = await readRow(client, input);
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "NOT_FOUND" };
    }
    const data = dataset(row);
    if (row.selected_version_status !== "READY") {
      await client.query("COMMIT");
      return {
        outcome: "DATASET_NOT_READY",
        dataset: data,
        status: row.selected_version_status,
      };
    }
    if (row.model_id === null || row.model_name === null) {
      if (row.model_id !== row.model_name)
        throw new Error("SEMANTIC_ONBOARDING_INCOMPLETE_MODEL");
      await client.query("COMMIT");
      return { outcome: "CAN_CREATE_DRAFT", dataset: data };
    }

    const draft = revision(row, "draft");
    const published = revision(row, "published");
    const structurallyBroken =
      (draft !== null && row.draft_dataset_id !== row.dataset_id) ||
      (published !== null && row.published_dataset_id !== row.dataset_id) ||
      (draft !== null && draft.status !== "DRAFT") ||
      (published !== null && published.status !== "PUBLISHED");
    if (structurallyBroken || (!draft && !published)) {
      await client.query("COMMIT");
      return { outcome: "BROKEN", dataset: data, message: brokenMessage };
    }

    if (published) {
      const inspection = await inspectPublishedSemanticModelSnapshot(client, {
        workspaceId: input.workspaceId,
        semanticModelId: row.model_id,
      });
      if (
        inspection.outcome !== "SUCCESS" ||
        inspection.inspection.revision.id !== published.id
      ) {
        await client.query("COMMIT");
        return { outcome: "BROKEN", dataset: data, message: brokenMessage };
      }
    }

    await client.query("COMMIT");
    const model = { id: row.model_id, name: row.model_name };
    if (draft)
      return {
        outcome: "DRAFT_AVAILABLE",
        dataset: data,
        model,
        draft: draft as SemanticOnboardingRevision & { status: "DRAFT" },
        published,
      };
    return {
      outcome: "PUBLISHED_ONLY",
      dataset: data,
      model,
      published: published as SemanticOnboardingRevision & {
        status: "PUBLISHED";
      },
    };
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Read outcome remains safely unavailable. */
    }
    return { outcome: "OPERATIONAL_FAILURE" };
  } finally {
    client.release();
  }
}
