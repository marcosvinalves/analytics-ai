import type { Pool } from "pg";
import { afterEach, expect, test, vi } from "vitest";
import * as storage from "../../src/lib/storage/resolve-local-raw.ts";
import * as csv from "../../src/modules/dataset/infrastructure/inspect-csv.ts";
import * as persistence from "../../src/modules/dataset/infrastructure/persist-dataset-profile.ts";
import * as lifecycle from "../../src/modules/dataset/infrastructure/dataset-version-lifecycle.ts";
import { ProcessingOperationalError } from "../../src/modules/dataset/domain/dataset-profile.ts";
import { processDatasetVersion } from "../../src/modules/dataset/application/process-dataset-version.ts";

afterEach(() => vi.restoreAllMocks());
test.each(["runtime", "commit"])(
  "falha %s não marca FAILED nem divulga detalhes",
  async (kind) => {
    const scope = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      datasetVersionId: "22222222-2222-4222-8222-222222222222",
    };
    vi.spyOn(persistence, "loadVersion").mockResolvedValue({
      status: "PROCESSING",
      source_type: "CSV",
    } as persistence.VersionReference);
    vi.spyOn(storage, "resolveLocalRaw").mockResolvedValue("internal.csv");
    const inspect = vi.spyOn(csv, "inspectCsv");
    const persist = vi.spyOn(persistence, "persistDatasetProfile");
    const failed = vi.spyOn(lifecycle, "markDatasetVersionFailed");
    if (kind === "runtime")
      inspect.mockRejectedValue(
        new Error("Out of Memory: secret internal path SQL"),
      );
    else {
      inspect.mockResolvedValue({ rowCount: BigInt(0), columns: [] });
      persist.mockRejectedValue(new ProcessingOperationalError(true));
    }
    const result = await processDatasetVersion({} as Pool, scope);
    expect(result).toMatchObject({
      outcome: "OPERATIONAL_FAILURE",
      code:
        kind === "runtime"
          ? "PROCESSING_OPERATIONAL_FAILURE"
          : "PROCESSING_OUTCOME_UNKNOWN",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|SQL|internal path|Out of Memory/,
    );
    expect(failed).not.toHaveBeenCalled();
    if (kind === "runtime") expect(persist).not.toHaveBeenCalled();
  },
);
