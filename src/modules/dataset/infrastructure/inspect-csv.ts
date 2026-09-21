import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { CSV_OPTIONS } from "./csv-options.ts";
import {
  ProcessingDataError,
  ProcessingOperationalError,
  validateDatasetProfile,
  type DatasetProfile,
} from "../domain/dataset-profile.ts";

export async function fingerprint(
  filename: string,
  maxBytes: number,
  validateEncoding: boolean,
): Promise<string> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ProcessingOperationalError();
    hash.update(chunk);
    if (validateEncoding) {
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        throw new ProcessingDataError("CSV_READ_FAILED");
      }
    }
  }
  if (validateEncoding) {
    try {
      decoder.decode();
    } catch {
      throw new ProcessingDataError("CSV_READ_FAILED");
    }
    if (!bytes) throw new ProcessingDataError("CSV_READ_FAILED");
  }
  return hash.digest("hex");
}

/** Narrow classification for the pinned DuckDB CSV reader, not substring matching of arbitrary exceptions. */
export function isDeterministicCsvError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const data = JSON.parse(error.message);
    return (
      data.exception_type === "Invalid Input" &&
      typeof data.exception_message === "string" &&
      /^(Error when sniffing file |CSV Error on Line:)/.test(
        data.exception_message,
      )
    );
  } catch {
    return false;
  }
}

export async function inspectCsv(
  filename: string,
  maxBytes: number,
): Promise<DatasetProfile> {
  const before = await fingerprint(filename, maxBytes, true);
  // Lazy loading allows native binding/import failures to remain operational.
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
      await connection.run("SET errors_as_json=true");
      try {
        await connection.run(
          `CREATE TEMP TABLE source AS SELECT * FROM read_csv($1,
          header=true, sample_size=-1, ${CSV_OPTIONS})`,
          [filename],
        );
      } catch (error) {
        if (
          isDeterministicCsvError(error) &&
          (await fingerprint(filename, maxBytes, false)) === before
        )
          throw new ProcessingDataError("CSV_READ_FAILED");
        throw new ProcessingOperationalError();
      }
      const schema = (
        await connection.runAndReadAll("DESCRIBE source")
      ).getRowObjects();
      const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const counts = (
        await connection.runAndReadAll(
          `SELECT count(*) AS total, ${schema.map((c, i) => `count(*) FILTER (WHERE ${quoted(String(c.column_name))} IS NULL) AS n${i}`).join(", ")} FROM source`,
        )
      ).getRowObjects()[0];
      const profile: DatasetProfile = {
        rowCount: counts.total as bigint,
        columns: schema.map((c, i) => ({
          physicalName: String(c.column_name),
          inferredType: String(c.column_type),
          ordinalPosition: i + 1,
          nullCount: counts[`n${i}`] as bigint,
          nullable: (counts[`n${i}`] as bigint) > BigInt(0) ? true : null,
        })),
      };
      validateDatasetProfile(profile);
      if ((await fingerprint(filename, maxBytes, false)) !== before)
        throw new ProcessingOperationalError();
      return profile;
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}
