import "server-only";
import { storageConfig } from "../../../lib/storage/config.ts";
import { resolveLocalRaw } from "../../../lib/storage/resolve-local-raw.ts";
import type { DatasetMetadata, Preview } from "../domain/dataset-detail.ts";
import { CSV_OPTIONS } from "./csv-options.ts";
import { fingerprint } from "./inspect-csv.ts";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function supportedType(type: string) {
  if (
    /^(BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|VARCHAR|DATE|TIME|TIMESTAMP|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS|TIMESTAMP WITH TIME ZONE|UUID)$/.test(
      type,
    )
  )
    return true;
  const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(type);
  return (
    decimal !== null &&
    Number(decimal[1]) >= 1 &&
    Number(decimal[1]) <= 38 &&
    Number(decimal[2]) <= Number(decimal[1])
  );
}

/** Read-only, bounded preview. Never calls lifecycle or writes metadata/raw. */
export async function readDatasetPreview(
  metadata: DatasetMetadata,
): Promise<Preview> {
  const { detail, raw } = metadata;
  if (detail.version.status !== "READY") return { state: "UNAVAILABLE" };
  try {
    const columns = detail.columns;
    if (
      raw.sourceType !== "CSV" ||
      columns.length === 0 ||
      columns.length !== detail.version.columnCount ||
      new Set(columns.map((c) => c.physicalName.toLowerCase())).size !==
        columns.length ||
      columns.some(
        (c, i) =>
          c.ordinalPosition !== i + 1 ||
          !c.physicalName.trim() ||
          c.physicalName.includes("\0") ||
          !supportedType(c.inferredType),
      )
    )
      throw new Error("Invalid persisted schema");
    const config = storageConfig();
    const filename = await resolveLocalRaw(config.root, raw, config.maxBytes);
    const before = await fingerprint(filename, config.maxBytes, true);
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:", {
      threads: "2",
      memory_limit: "256MB",
      max_temp_directory_size: "0B",
      autoload_known_extensions: "false",
      autoinstall_known_extensions: "false",
    });
    try {
      const connection = await instance.connect();
      try {
        await connection.run("SET TimeZone='UTC'");
        // Read the header as data with a fixed VARCHAR schema: no sniffing or type inference.
        const headerColumns = columns
          .map((_, i) => `${literal(`h${i}`)}:'VARCHAR'`)
          .join(",");
        const header = (
          await connection.runAndReadAll(
            `SELECT ${columns.map((_, i) => identifier(`h${i}`)).join(",")} FROM read_csv($1, auto_detect=false, header=false, columns={${headerColumns}}, ${CSV_OPTIONS}) LIMIT 1`,
            [filename],
          )
        ).getRows()[0];
        if (!header) throw new Error("Missing header");
        // Let DuckDB deduplicate identifiers as in T-007. This binds names, it does not infer types.
        const digits = String(columns.length - 1).length;
        const names = header.map((name, i) => {
          const trimmed = name === null ? "" : String(name).trim();
          return trimmed || `column${String(i).padStart(digits, "0")}`;
        });
        await connection.run(
          `CREATE TEMP VIEW preview_header AS SELECT ${names.map((name) => `NULL AS ${identifier(name)}`).join(",")}`,
        );
        const boundNames = (
          await connection.runAndReadAll("SELECT * FROM preview_header LIMIT 0")
        ).columnNames();
        if (boundNames.some((name, i) => name !== columns[i].physicalName))
          throw new Error("Header mismatch");
        const fixedSchema = columns
          .map((c) => `${literal(c.physicalName)}:${literal(c.inferredType)}`)
          .join(",");
        const reader = await connection.runAndReadAll(
          `SELECT ${columns.map((c) => `CAST(${identifier(c.physicalName)} AS VARCHAR)`).join(",")} FROM read_csv($1, auto_detect=false, header=true, columns={${fixedSchema}}, ${CSV_OPTIONS}) LIMIT 50`,
          [filename],
        );
        const rows = reader.getRows().map((row) =>
          row.map((value, i) => {
            if (value !== null && typeof value !== "string")
              throw new Error("Unexpected representation");
            return { column: columns[i].physicalName, value };
          }),
        );
        if ((await fingerprint(filename, config.maxBytes, false)) !== before)
          throw new Error("Raw changed");
        return { state: "AVAILABLE", rows, limit: 50 };
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  } catch {
    return {
      state: "ERROR",
      code: "PREVIEW_READ_FAILED",
      message:
        "Não foi possível ler o preview. O arquivo ou sua estrutura podem estar indisponíveis ou incompatíveis. O estado da versão não foi alterado.",
    };
  }
}
