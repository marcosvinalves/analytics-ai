import type { Pool } from "pg";
import { storageConfig } from "../../../lib/storage/config.ts";
import { resolveLocalRaw } from "../../../lib/storage/resolve-local-raw.ts";
import { inspectCsv } from "../infrastructure/inspect-csv.ts";
import {
  loadVersion,
  persistDatasetProfile,
} from "../infrastructure/persist-dataset-profile.ts";
import { markDatasetVersionFailed } from "../infrastructure/dataset-version-lifecycle.ts";
import {
  SAFE_PROCESSING_MESSAGE,
  validateVersionScope,
  type VersionScope,
  type TransitionResult,
} from "../domain/dataset-version-lifecycle.ts";
import {
  ProcessingDataError,
  ProcessingOperationalError,
} from "../domain/dataset-profile.ts";

export type ProcessingResult =
  | TransitionResult
  | {
      outcome: "OPERATIONAL_FAILURE";
      code: "PROCESSING_OPERATIONAL_FAILURE" | "PROCESSING_OUTCOME_UNKNOWN";
      message: string;
    };
/** Internal explicit processing only. Server-supplied workspace scope is NOT authentication/authorization. */
export async function processDatasetVersion(
  pool: Pool,
  scope: VersionScope,
): Promise<ProcessingResult> {
  validateVersionScope(scope);
  try {
    const reference = await loadVersion(pool, scope);
    if (!reference) return { outcome: "NOT_FOUND" };
    if (reference.status !== "PROCESSING")
      return { outcome: "ALREADY_TERMINAL", status: reference.status };
    if (reference.source_type !== "CSV") throw new ProcessingOperationalError();
    let profile;
    try {
      const config = storageConfig();
      const filename = await resolveLocalRaw(
        config.root,
        {
          namespace: reference.storage_namespace,
          key: reference.storage_key,
          sizeBytes: reference.size_bytes,
        },
        config.maxBytes,
      );
      profile = await inspectCsv(filename, config.maxBytes);
    } catch (error) {
      if (!(error instanceof ProcessingDataError)) throw error;
      // Only definitive data failures can transition to FAILED. Database failures never enter this branch.
      try {
        return await markDatasetVersionFailed(pool, {
          ...scope,
          errorCode: error.code,
          errorMessage: SAFE_PROCESSING_MESSAGE,
        });
      } catch {
        throw new ProcessingOperationalError(true);
      }
    }
    return await persistDatasetProfile(pool, scope, reference, profile);
  } catch (error) {
    return {
      outcome: "OPERATIONAL_FAILURE",
      code:
        error instanceof ProcessingOperationalError && error.outcomeUnknown
          ? "PROCESSING_OUTCOME_UNKNOWN"
          : "PROCESSING_OPERATIONAL_FAILURE",
      message:
        "Não foi possível concluir o processamento. Verifique o estado antes de uma nova tentativa explícita.",
    };
  }
}
