import "server-only";
import { storageConfig } from "../../../lib/storage/config.ts";
import { resolveLocalRaw } from "../../../lib/storage/resolve-local-raw.ts";
import type { DatasetMetadata, Preview } from "../domain/dataset-detail.ts";
import { CSV_OPTIONS } from "./csv-options.ts";
import { fingerprint } from "./inspect-csv.ts";
import {
  fixedCsvSchema,
  sqlIdentifier,
  validateCsvHeader,
  validatePersistedColumns,
  withLocalDuckDB,
} from "./local-duckdb-csv.ts";

/** Read-only, bounded preview. Never calls lifecycle or writes metadata/raw. */
export async function readDatasetPreview(
  metadata: DatasetMetadata,
): Promise<Preview> {
  const { detail, raw } = metadata;
  if (detail.version.status !== "READY") return { state: "UNAVAILABLE" };
  try {
    const columns = detail.columns;
    validatePersistedColumns(metadata);
    const config = storageConfig();
    const filename = await resolveLocalRaw(config.root, raw, config.maxBytes);
    const before = await fingerprint(filename, config.maxBytes, true);
    const preview = await withLocalDuckDB<Preview>(async (connection) => {
      await validateCsvHeader(connection, filename, columns);
      const fixedSchema = fixedCsvSchema(columns);
      const reader = await connection.runAndReadAll(
        `SELECT ${columns.map((c) => `CAST(${sqlIdentifier(c.physicalName)} AS VARCHAR)`).join(",")} FROM read_csv($1, auto_detect=false, header=true, columns={${fixedSchema}}, ${CSV_OPTIONS}) LIMIT 50`,
        [filename],
      );
      const rows = reader.getRows().map((row) =>
        row.map((value, i) => {
          if (value !== null && typeof value !== "string")
            throw new Error("Unexpected representation");
          return { column: columns[i].physicalName, value };
        }),
      );
      return { state: "AVAILABLE", rows, limit: 50 };
    });
    if ((await fingerprint(filename, config.maxBytes, false)) !== before)
      throw new Error("Raw changed");
    return preview;
  } catch {
    return {
      state: "ERROR",
      code: "PREVIEW_READ_FAILED",
      message:
        "Não foi possível ler o preview. O arquivo ou sua estrutura podem estar indisponíveis ou incompatíveis. O estado da versão não foi alterado.",
    };
  }
}
