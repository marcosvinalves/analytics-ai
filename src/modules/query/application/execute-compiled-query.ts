import type { CompiledQuery } from "../domain/compiled-query.ts";
import type { QueryResult } from "../domain/query-result.ts";
import { executeDuckDBQuery } from "../infrastructure/duckdb-query-executor.ts";

export type QueryExecutionFailure =
  | "SOURCE_SCHEMA_MISMATCH"
  | "SOURCE_VALUE_INVALID"
  | "NUMERIC_OVERFLOW"
  | "SOURCE_INTEGRITY_FAILED"
  | "RESULT_LIMIT_EXCEEDED"
  | "RESULT_SIZE_LIMIT_EXCEEDED"
  | "QUERY_TIMEOUT"
  | "QUERY_CANCELLED"
  | "INCONSISTENT_COMPILED_QUERY"
  | "INCONSISTENT_QUERY_RESULT"
  | "QUERY_OPERATIONAL_FAILURE";

export type ExecuteCompiledQueryResult =
  | Readonly<{ outcome: "SUCCESS"; result: QueryResult }>
  | Readonly<{ outcome: QueryExecutionFailure }>;

export type QueryExecutionOptions = Readonly<{ signal?: AbortSignal }>;

export async function executeCompiledQuery(
  compiledQuery: CompiledQuery,
  options: QueryExecutionOptions = {},
): Promise<ExecuteCompiledQueryResult> {
  return executeDuckDBQuery(compiledQuery, options);
}
