import "server-only";
import type { Pool } from "pg";
import { validId } from "../domain/dataset-detail.ts";
import {
  GROUND_TRUTH_SAFE_MESSAGE,
  GroundTruthError,
  type GroundTruthAggregationResult,
} from "../domain/ground-truth-aggregation.ts";
import { aggregateGroundTruth } from "../infrastructure/aggregate-ground-truth.ts";
import { readGroundTruthMetadata } from "../infrastructure/read-dataset-metadata.ts";

export async function runGroundTruthAggregation(
  pool: Pool,
  input: { workspaceId: string; datasetVersionId: string },
): Promise<GroundTruthAggregationResult> {
  if (!input || !validId(input.workspaceId) || !validId(input.datasetVersionId))
    return { outcome: "NOT_FOUND" };
  try {
    const metadata = await readGroundTruthMetadata(pool, input);
    if (!metadata) return { outcome: "NOT_FOUND" };
    if (metadata.detail.version.status !== "READY")
      return {
        outcome: "NOT_READY",
        status: metadata.detail.version.status,
      };
    return await aggregateGroundTruth(metadata);
  } catch (error) {
    return {
      outcome: "ERROR",
      code:
        error instanceof GroundTruthError
          ? error.code
          : "GROUND_TRUTH_OPERATIONAL_FAILURE",
      message: GROUND_TRUTH_SAFE_MESSAGE,
    };
  }
}
