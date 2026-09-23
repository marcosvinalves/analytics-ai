import type { DuckDBConnection } from "@duckdb/node-api";
import type { DatasetMetadata } from "../domain/dataset-detail.ts";
import { CSV_OPTIONS } from "./csv-options.ts";

export const sqlIdentifier = (value: string) =>
  `"${value.replaceAll('"', '""')}"`;
export const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function supportedPhysicalType(type: string): boolean {
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

export function validatePersistedColumns(metadata: DatasetMetadata): void {
  const { columns, version } = metadata.detail;
  if (
    metadata.raw.sourceType !== "CSV" ||
    columns.length === 0 ||
    columns.length !== version.columnCount ||
    new Set(columns.map((column) => column.physicalName.toLowerCase())).size !==
      columns.length ||
    columns.some(
      (column, index) =>
        column.ordinalPosition !== index + 1 ||
        !column.physicalName.trim() ||
        column.physicalName.includes("\0") ||
        !supportedPhysicalType(column.inferredType),
    )
  )
    throw new Error("INVALID_PERSISTED_SCHEMA");
}

export async function withLocalDuckDB<T>(
  work: (connection: DuckDBConnection) => Promise<T>,
): Promise<T> {
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
      await connection.run("SET errors_as_json=true");
      return await work(connection);
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

/** Validates the raw header against persisted, normalized physical names without type inference. */
export async function validateCsvHeader(
  connection: DuckDBConnection,
  filename: string,
  columns: DatasetMetadata["detail"]["columns"],
): Promise<void> {
  const headerColumns = columns
    .map((_, index) => `${sqlLiteral(`h${index}`)}:'VARCHAR'`)
    .join(",");
  const header = (
    await connection.runAndReadAll(
      `SELECT ${columns.map((_, index) => sqlIdentifier(`h${index}`)).join(",")} FROM read_csv($1, auto_detect=false, header=false, columns={${headerColumns}}, ${CSV_OPTIONS}) LIMIT 1`,
      [filename],
    )
  ).getRows()[0];
  if (!header) throw new Error("MISSING_CSV_HEADER");
  const digits = String(columns.length - 1).length;
  const names = header.map((name, index) => {
    const trimmed = name === null ? "" : String(name).trim();
    return trimmed || `column${String(index).padStart(digits, "0")}`;
  });
  await connection.run(
    `CREATE OR REPLACE TEMP VIEW persisted_header_check AS SELECT ${names.map((name) => `NULL AS ${sqlIdentifier(name)}`).join(",")}`,
  );
  const boundNames = (
    await connection.runAndReadAll(
      "SELECT * FROM persisted_header_check LIMIT 0",
    )
  ).columnNames();
  if (boundNames.some((name, index) => name !== columns[index].physicalName))
    throw new Error("CSV_HEADER_MISMATCH");
}

export function fixedCsvSchema(
  columns: DatasetMetadata["detail"]["columns"],
  asText = false,
): string {
  return columns
    .map(
      (column) =>
        `${sqlLiteral(column.physicalName)}:${sqlLiteral(asText ? "VARCHAR" : column.inferredType)}`,
    )
    .join(",");
}
