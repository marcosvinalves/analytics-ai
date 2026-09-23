import "server-only";
import { storageConfig } from "../../../lib/storage/config.ts";
import { resolveLocalRaw } from "../../../lib/storage/resolve-local-raw.ts";
import type { DatasetMetadata } from "../domain/dataset-detail.ts";
import {
  GroundTruthError,
  type GroundTruthAggregationResult,
} from "../domain/ground-truth-aggregation.ts";
import { CSV_OPTIONS } from "./csv-options.ts";
import { fingerprint } from "./inspect-csv.ts";
import {
  fixedCsvSchema,
  sqlIdentifier,
  validateCsvHeader,
  validatePersistedColumns,
  withLocalDuckDB,
} from "./local-duckdb-csv.ts";

const NUMERIC_PHYSICAL_TYPE =
  /^(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL\(\d+,\d+\))$/;

export async function aggregateGroundTruth(
  metadata: DatasetMetadata,
): Promise<Extract<GroundTruthAggregationResult, { outcome: "SUCCESS" }>> {
  try {
    validatePersistedColumns(metadata);
  } catch {
    throw new GroundTruthError("GROUND_TRUTH_SCHEMA_INVALID");
  }
  const columns = metadata.detail.columns;
  const quantity = columns.find(
    (column) => column.physicalName === "quantidade",
  );
  const price = columns.find(
    (column) => column.physicalName === "preco_unitario",
  );
  if (
    !quantity ||
    !price ||
    !NUMERIC_PHYSICAL_TYPE.test(quantity.inferredType) ||
    !NUMERIC_PHYSICAL_TYPE.test(price.inferredType)
  )
    throw new GroundTruthError("GROUND_TRUTH_SCHEMA_INVALID");

  const config = storageConfig();
  let filename: string;
  try {
    filename = await resolveLocalRaw(
      config.root,
      metadata.raw,
      config.maxBytes,
    );
  } catch {
    throw new GroundTruthError("GROUND_TRUTH_READ_FAILED");
  }
  let before: string;
  try {
    before = await fingerprint(filename, config.maxBytes, true);
  } catch {
    throw new GroundTruthError("GROUND_TRUTH_READ_FAILED");
  }

  let result: Extract<GroundTruthAggregationResult, { outcome: "SUCCESS" }>;
  try {
    result = await withLocalDuckDB(async (connection) => {
      try {
        await validateCsvHeader(connection, filename, columns);
        const textSchema = fixedCsvSchema(columns, true);
        // Re-read original text: never convert the persisted DOUBLE back into DECIMAL.
        await connection.run(
          `CREATE TEMP TABLE ground_truth_raw AS SELECT * FROM read_csv($1, auto_detect=false, header=true, columns={${textSchema}}, ${CSV_OPTIONS})`,
          [filename],
        );
      } catch {
        throw new GroundTruthError("GROUND_TRUTH_READ_FAILED");
      }

      const q = sqlIdentifier(quantity.physicalName);
      const p = sqlIdentifier(price.physicalName);
      const validation = (
        await connection.runAndReadAll(
          `SELECT
             count(*) FILTER (WHERE ${q} IS NOT NULL AND NOT regexp_full_match(${q}, '[+-]?[0-9]+')) AS invalid_quantity,
             count(*) FILTER (WHERE ${p} IS NOT NULL AND NOT regexp_full_match(${p}, '[+-]?(?:[0-9]+(?:\\.[0-9]{1,2})?|\\.[0-9]{1,2})')) AS invalid_price,
             count(*) FILTER (WHERE ${q} IS NOT NULL AND regexp_full_match(${q}, '[+-]?[0-9]+') AND try_cast(${q} AS DECIMAL(18,0)) IS NULL) AS quantity_overflow,
             count(*) FILTER (WHERE ${p} IS NOT NULL AND regexp_full_match(${p}, '[+-]?(?:[0-9]+(?:\\.[0-9]{1,2})?|\\.[0-9]{1,2})') AND try_cast(${p} AS DECIMAL(18,2)) IS NULL) AS price_overflow
           FROM ground_truth_raw`,
        )
      ).getRowObjects()[0] as Record<string, bigint>;
      if (
        validation.invalid_quantity > BigInt(0) ||
        validation.invalid_price > BigInt(0)
      )
        throw new GroundTruthError("GROUND_TRUTH_INPUT_INVALID");
      if (
        validation.quantity_overflow > BigInt(0) ||
        validation.price_overflow > BigInt(0)
      )
        throw new GroundTruthError("GROUND_TRUTH_OVERFLOW");

      try {
        const persistedSchema = fixedCsvSchema(columns);
        // Validate every raw value against the persisted physical schema after
        // the specific textual operand contract has produced precise errors.
        await connection.run(
          `CREATE TEMP TABLE persisted_source AS SELECT * FROM read_csv($1, auto_detect=false, header=true, columns={${persistedSchema}}, ${CSV_OPTIONS})`,
          [filename],
        );
      } catch {
        throw new GroundTruthError("GROUND_TRUTH_READ_FAILED");
      }

      try {
        const aggregate = (
          await connection.runAndReadAll(
            `SELECT
               CAST(SUM(CAST(${q} AS DECIMAL(18,0)) * CAST(${p} AS DECIMAL(18,2))) AS VARCHAR) AS total,
               typeof(CAST(0 AS DECIMAL(18,0))) AS quantity_type,
               typeof(CAST(0 AS DECIMAL(18,2))) AS price_type,
               typeof(CAST(0 AS DECIMAL(18,0)) * CAST(0 AS DECIMAL(18,2))) AS product_type,
               typeof(SUM(CAST(${q} AS DECIMAL(18,0)) * CAST(${p} AS DECIMAL(18,2)))) AS sum_type,
               CAST(count(*) AS VARCHAR) AS row_count,
               CAST(count(CAST(${q} AS DECIMAL(18,0)) * CAST(${p} AS DECIMAL(18,2))) AS VARCHAR) AS contributing_rows
             FROM ground_truth_raw`,
          )
        ).getRowObjects()[0];
        if (
          aggregate.quantity_type !== "DECIMAL(18,0)" ||
          aggregate.price_type !== "DECIMAL(18,2)" ||
          aggregate.product_type !== "DECIMAL(18,2)" ||
          aggregate.sum_type !== "DECIMAL(38,2)" ||
          (aggregate.total !== null && typeof aggregate.total !== "string") ||
          typeof aggregate.row_count !== "string" ||
          typeof aggregate.contributing_rows !== "string"
        )
          throw new GroundTruthError("GROUND_TRUTH_OPERATIONAL_FAILURE");
        return {
          outcome: "SUCCESS",
          value: aggregate.total as string | null,
          type: aggregate.sum_type,
          rowCount: aggregate.row_count,
          contributingRows: aggregate.contributing_rows,
        };
      } catch (error) {
        if (error instanceof GroundTruthError) throw error;
        try {
          const payload = JSON.parse(
            error instanceof Error ? error.message : "",
          );
          if (payload.exception_type === "Out of Range")
            throw new GroundTruthError("GROUND_TRUTH_OVERFLOW");
        } catch (parsed) {
          if (parsed instanceof GroundTruthError) throw parsed;
        }
        throw new GroundTruthError("GROUND_TRUTH_OPERATIONAL_FAILURE");
      }
    });
  } catch (error) {
    if (error instanceof GroundTruthError) throw error;
    throw new GroundTruthError("GROUND_TRUTH_OPERATIONAL_FAILURE");
  }
  try {
    if ((await fingerprint(filename, config.maxBytes, false)) !== before)
      throw new Error("RAW_CHANGED");
  } catch {
    throw new GroundTruthError("GROUND_TRUTH_READ_FAILED");
  }
  return result;
}
