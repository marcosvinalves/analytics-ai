import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  normalizedDescription,
  validateCreateSemanticModelDraftInput,
  type CreateSemanticModelDraftInput,
  type CreateSemanticModelDraftResult,
  type DatasetVersionStatus,
  type SemanticModelRevisionSnapshot,
  type SemanticModelSnapshot,
  type SemanticRevisionStatus,
} from "../domain/semantic-model.ts";

type ModelRow = {
  id: string;
  dataset_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
};

type RevisionRow = {
  id: string;
  semantic_model_id: string;
  dataset_version_id: string;
  revision_number: number;
  status: SemanticRevisionStatus;
  label: string;
  description: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const modelColumns = "id, dataset_id, name, created_at, updated_at";
const revisionColumns = `id, semantic_model_id, dataset_version_id, revision_number,
  status, label, description, published_at, created_at, updated_at`;

function modelSnapshot(row: ModelRow): SemanticModelSnapshot {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function revisionSnapshot(row: RevisionRow): SemanticModelRevisionSnapshot {
  return {
    id: row.id,
    semanticModelId: row.semantic_model_id,
    datasetVersionId: row.dataset_version_id,
    revisionNumber: row.revision_number,
    status: row.status,
    label: row.label,
    description: row.description,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exactDraft(
  model: ModelRow,
  revision: RevisionRow,
  input: CreateSemanticModelDraftInput,
  description: string | null,
): boolean {
  return (
    model.dataset_id === input.datasetId &&
    model.name === input.modelName &&
    revision.dataset_version_id === input.datasetVersionId &&
    revision.label === input.label &&
    revision.description === description
  );
}

async function finishWithoutWrite(
  client: PoolClient,
  result: CreateSemanticModelDraftResult,
): Promise<CreateSemanticModelDraftResult> {
  await client.query("ROLLBACK");
  client.release();
  return result;
}

async function reconcileCommittedDraft(
  pool: Pool,
  input: CreateSemanticModelDraftInput,
  description: string | null,
): Promise<CreateSemanticModelDraftResult | undefined> {
  const result = await pool.query<ModelRow & RevisionRow>(
    `SELECT m.id, m.dataset_id, m.name, m.created_at, m.updated_at,
      r.id AS revision_id, r.semantic_model_id, r.dataset_version_id, r.revision_number,
      r.status, r.label, r.description, r.published_at,
      r.created_at AS revision_created_at, r.updated_at AS revision_updated_at
    FROM app.semantic_models m
    JOIN app.datasets d ON d.id = m.dataset_id
    JOIN app.semantic_model_revisions r ON r.semantic_model_id = m.id AND r.status = 'DRAFT'
    WHERE d.id = $1 AND d.workspace_id = $2 AND r.dataset_version_id = $3`,
    [input.datasetId, input.workspaceId, input.datasetVersionId],
  );
  const row = result.rows[0] as
    | (ModelRow & {
        revision_id: string;
        semantic_model_id: string;
        dataset_version_id: string;
        revision_number: number;
        status: SemanticRevisionStatus;
        label: string;
        description: string | null;
        published_at: Date | null;
        revision_created_at: Date;
        revision_updated_at: Date;
      })
    | undefined;
  if (!row) return undefined;
  const revision: RevisionRow = {
    id: row.revision_id,
    semantic_model_id: row.semantic_model_id,
    dataset_version_id: row.dataset_version_id,
    revision_number: row.revision_number,
    status: row.status,
    label: row.label,
    description: row.description,
    published_at: row.published_at,
    created_at: row.revision_created_at,
    updated_at: row.revision_updated_at,
  };
  if (!exactDraft(row, revision, input, description)) return undefined;
  return {
    outcome: "EXISTING",
    model: modelSnapshot(row),
    revision: revisionSnapshot(revision),
  };
}

/**
 * Internal metadata operation, not authorization. Payload equality is only the
 * idempotency rule for creation; DRAFT revisions remain conceptually editable.
 */
export async function createSemanticModelDraft(
  pool: Pool,
  input: CreateSemanticModelDraftInput,
): Promise<CreateSemanticModelDraftResult> {
  validateCreateSemanticModelDraftInput(input);
  const description = normalizedDescription(input.description);
  const modelId = randomUUID();
  const revisionId = randomUUID();
  let client: PoolClient | undefined;
  let connected = false;
  let commitStarted = false;
  let rollbackConfirmed = false;
  try {
    client = await pool.connect();
    connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '2s'");

    const scope = await client.query<{
      status: DatasetVersionStatus;
    }>(
      `SELECT v.status
      FROM app.datasets d
      JOIN app.dataset_versions v ON v.dataset_id = d.id
      WHERE d.id = $1 AND d.workspace_id = $2 AND v.id = $3
      FOR SHARE OF d, v`,
      [input.datasetId, input.workspaceId, input.datasetVersionId],
    );
    const status = scope.rows[0]?.status;
    if (!status)
      return await finishWithoutWrite(client, { outcome: "NOT_FOUND" });
    if (status !== "READY")
      return await finishWithoutWrite(client, {
        outcome: "VERSION_NOT_READY",
        status,
      });

    await client.query(
      `INSERT INTO app.semantic_models(id, dataset_id, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (dataset_id) DO NOTHING`,
      [modelId, input.datasetId, input.modelName],
    );
    const model = (
      await client.query<ModelRow>(
        `SELECT ${modelColumns} FROM app.semantic_models
        WHERE dataset_id = $1 FOR UPDATE`,
        [input.datasetId],
      )
    ).rows[0];
    if (!model) throw new Error("Semantic model invariant violated");
    if (model.name !== input.modelName)
      return await finishWithoutWrite(client, {
        outcome: "CONFLICT",
        reason: "MODEL_NAME_MISMATCH",
      });

    const draft = (
      await client.query<RevisionRow>(
        `SELECT ${revisionColumns} FROM app.semantic_model_revisions
        WHERE semantic_model_id = $1 AND status = 'DRAFT'`,
        [model.id],
      )
    ).rows[0];
    if (draft) {
      if (!exactDraft(model, draft, input, description))
        return await finishWithoutWrite(client, {
          outcome: "CONFLICT",
          reason: "DRAFT_ALREADY_EXISTS",
        });
      return await finishWithoutWrite(client, {
        outcome: "EXISTING",
        model: modelSnapshot(model),
        revision: revisionSnapshot(draft),
      });
    }

    const nextNumber = (
      await client.query<{ next_number: number }>(
        `SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS next_number
        FROM app.semantic_model_revisions WHERE semantic_model_id = $1`,
        [model.id],
      )
    ).rows[0].next_number;
    const revision = (
      await client.query<RevisionRow>(
        `INSERT INTO app.semantic_model_revisions
          (id, semantic_model_id, dataset_version_id, revision_number, label, description)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING ${revisionColumns}`,
        [
          revisionId,
          model.id,
          input.datasetVersionId,
          nextNumber,
          input.label,
          description,
        ],
      )
    ).rows[0];

    commitStarted = true;
    await client.query("COMMIT");
    client.release();
    client = undefined;
    return {
      outcome: "CREATED",
      model: modelSnapshot(model),
      revision: revisionSnapshot(revision),
    };
  } catch {
    if (client && !commitStarted) {
      try {
        await client.query("ROLLBACK");
        rollbackConfirmed = true;
      } catch {
        /* The outcome cannot be inferred from a failed rollback. */
      }
    }
    client?.release(true);
    client = undefined;
    if (commitStarted) {
      try {
        const reconciled = await reconcileCommittedDraft(
          pool,
          input,
          description,
        );
        if (reconciled) return reconciled;
      } catch {
        /* Do not expose database details or infer rollback from absence. */
      }
      throw new Error(
        "SEMANTIC_DRAFT_OUTCOME_UNKNOWN: nao foi possivel confirmar a criacao do draft.",
      );
    }
    if (rollbackConfirmed || !connected)
      throw new Error(
        "SEMANTIC_DRAFT_WRITE_FAILED: nao foi possivel criar o draft semantico.",
      );
    throw new Error(
      "SEMANTIC_DRAFT_OUTCOME_UNKNOWN: nao foi possivel confirmar a criacao do draft.",
    );
  }
}
