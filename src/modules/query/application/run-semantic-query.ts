import "server-only";

import type { Pool } from "pg";
import { resolveAnalyticalSource } from "../../dataset/application/resolve-analytical-source.ts";
import { inspectPublishedSemanticModel } from "../../semantic/infrastructure/semantic-inspection.ts";
import { buildQueryExplanation } from "../domain/build-query-explanation.ts";
import type { QueryExplanation } from "../domain/query-explanation.ts";
import type { QueryResult } from "../domain/query-result.ts";
import { planPhysicalQuery } from "../domain/plan-physical-query.ts";
import { resolveSemanticQuery } from "../domain/resolve-semantic-query.ts";
import {
  parseSemanticQuery,
  type SemanticQueryIssue,
} from "../domain/semantic-query.ts";
import { compilePhysicalQuery } from "../infrastructure/duckdb-query-compiler.ts";
import { executeCompiledQuery } from "./execute-compiled-query.ts";

export type RunSemanticQueryInput = Readonly<{
  workspaceId: string;
  semanticModelId: string;
  query: unknown;
}>;

export type RunSemanticQueryOptions = Readonly<{ signal?: AbortSignal }>;

export type SemanticQueryExecution = Readonly<{
  result: QueryResult;
  explanation: QueryExplanation;
}>;

type SimpleFailureCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_PUBLISHED"
  | "QUERY_NOT_SUPPORTED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_INCONSISTENT"
  | "QUERY_EXECUTION_FAILED"
  | "QUERY_TIMEOUT"
  | "QUERY_CANCELLED"
  | "RESULT_LIMIT_EXCEEDED"
  | "RESULT_TOO_LARGE"
  | "INCONSISTENT_QUERY_PIPELINE"
  | "OPERATIONAL_FAILURE";

export type RunSemanticQueryResult =
  | Readonly<{ outcome: "SUCCESS"; execution: SemanticQueryExecution }>
  | Readonly<{
      outcome: "INVALID_QUERY";
      message: string;
      issues: readonly SemanticQueryIssue[];
    }>
  | Readonly<{
      outcome: "DATA_NOT_READY";
      message: string;
      status: "PROCESSING" | "FAILED";
    }>
  | Readonly<{ outcome: SimpleFailureCode; message: string }>;

const MESSAGES: Record<
  SimpleFailureCode | "INVALID_QUERY" | "DATA_NOT_READY",
  string
> = {
  INVALID_QUERY: "A consulta informada e invalida.",
  MODEL_NOT_FOUND: "O modelo semantico nao foi encontrado.",
  MODEL_NOT_PUBLISHED: "O modelo semantico nao possui revisao publicada.",
  DATA_NOT_READY: "Os dados ainda nao estao prontos para consulta.",
  QUERY_NOT_SUPPORTED: "A consulta nao pode ser executada.",
  SOURCE_UNAVAILABLE: "A fonte de dados nao esta disponivel.",
  SOURCE_INCONSISTENT: "A fonte de dados esta inconsistente.",
  QUERY_EXECUTION_FAILED: "A consulta falhou durante a execucao.",
  QUERY_TIMEOUT: "A consulta excedeu o tempo limite.",
  QUERY_CANCELLED: "A consulta foi cancelada.",
  RESULT_LIMIT_EXCEEDED: "O resultado excedeu o limite de linhas.",
  RESULT_TOO_LARGE: "O resultado excedeu o tamanho permitido.",
  INCONSISTENT_QUERY_PIPELINE: "Os artefatos da consulta estao inconsistentes.",
  OPERATIONAL_FAILURE: "Nao foi possivel concluir a consulta.",
};

function failure(outcome: SimpleFailureCode): RunSemanticQueryResult {
  return { outcome, message: MESSAGES[outcome] };
}

function cancelled(
  signal: AbortSignal | undefined,
): RunSemanticQueryResult | undefined {
  return signal?.aborted ? failure("QUERY_CANCELLED") : undefined;
}

/**
 * Internal server-side orchestration. The caller must authorize workspaceId
 * before invoking it; workspace scoping here is not authentication.
 */
export async function runSemanticQuery(
  pool: Pool,
  input: RunSemanticQueryInput,
  options: RunSemanticQueryOptions = {},
): Promise<RunSemanticQueryResult> {
  const initialCancellation = cancelled(options.signal);
  if (initialCancellation) return initialCancellation;

  const parsed = parseSemanticQuery(input.query);
  if (!parsed.valid)
    return {
      outcome: "INVALID_QUERY",
      message: MESSAGES.INVALID_QUERY,
      issues: parsed.error.issues,
    };

  let inspected: Awaited<ReturnType<typeof inspectPublishedSemanticModel>>;
  try {
    inspected = await inspectPublishedSemanticModel(pool, {
      workspaceId: input.workspaceId,
      semanticModelId: input.semanticModelId,
    });
  } catch (error) {
    return failure(
      error instanceof TypeError ? "MODEL_NOT_FOUND" : "OPERATIONAL_FAILURE",
    );
  }
  const afterInspectionCancellation = cancelled(options.signal);
  if (afterInspectionCancellation) return afterInspectionCancellation;
  if (inspected.outcome === "NOT_FOUND") return failure("MODEL_NOT_FOUND");
  if (inspected.outcome === "NO_PUBLISHED_REVISION")
    return failure("MODEL_NOT_PUBLISHED");
  if (inspected.outcome === "INCONSISTENT_SNAPSHOT")
    return failure("INCONSISTENT_QUERY_PIPELINE");
  if (inspected.outcome === "OPERATIONAL_FAILURE")
    return failure("OPERATIONAL_FAILURE");

  const resolved = resolveSemanticQuery(parsed.query, inspected.inspection);
  if (resolved.outcome === "REVISION_NOT_PUBLISHED")
    return failure("INCONSISTENT_QUERY_PIPELINE");
  if (resolved.outcome === "INVALID_SEMANTIC_QUERY")
    return failure("QUERY_NOT_SUPPORTED");

  const beforeSourceCancellation = cancelled(options.signal);
  if (beforeSourceCancellation) return beforeSourceCancellation;
  const source = await resolveAnalyticalSource(pool, {
    workspaceId: input.workspaceId,
    datasetId: resolved.query.dataset.id,
    datasetVersionId: resolved.query.datasetVersion.id,
  });
  const afterSourceCancellation = cancelled(options.signal);
  if (afterSourceCancellation) return afterSourceCancellation;
  if (source.outcome === "NOT_FOUND")
    return failure("INCONSISTENT_QUERY_PIPELINE");
  if (source.outcome === "NOT_READY")
    return inspected.inspection.datasetVersion.status === source.status
      ? {
          outcome: "DATA_NOT_READY",
          message: MESSAGES.DATA_NOT_READY,
          status: source.status,
        }
      : failure("INCONSISTENT_QUERY_PIPELINE");
  if (source.outcome === "UNSUPPORTED_SOURCE_TYPE")
    return failure("QUERY_NOT_SUPPORTED");
  if (source.outcome === "SOURCE_UNAVAILABLE")
    return failure("SOURCE_UNAVAILABLE");
  if (source.outcome === "SOURCE_INTEGRITY_FAILED")
    return failure("SOURCE_INCONSISTENT");
  if (source.outcome === "OPERATIONAL_FAILURE")
    return failure("OPERATIONAL_FAILURE");

  const planned = planPhysicalQuery(resolved.query, source.source);
  if (planned.outcome === "UNSUPPORTED_SOURCE_TYPE")
    return failure("QUERY_NOT_SUPPORTED");
  if (planned.outcome === "UNSUPPORTED_PHYSICAL_CONVERSION")
    return failure("QUERY_NOT_SUPPORTED");
  if (
    planned.outcome === "SOURCE_MISMATCH" ||
    planned.outcome === "INCONSISTENT_RESOLVED_QUERY"
  )
    return failure("INCONSISTENT_QUERY_PIPELINE");

  const compiled = compilePhysicalQuery(planned.plan);
  if (compiled.outcome === "UNSUPPORTED_COMPILATION")
    return failure("QUERY_NOT_SUPPORTED");
  if (compiled.outcome === "INCONSISTENT_PHYSICAL_PLAN")
    return failure("INCONSISTENT_QUERY_PIPELINE");

  const beforeExecutionCancellation = cancelled(options.signal);
  if (beforeExecutionCancellation) return beforeExecutionCancellation;
  const executed = await executeCompiledQuery(compiled.compiledQuery, {
    signal: options.signal,
  });
  if (executed.outcome !== "SUCCESS") {
    if (
      executed.outcome === "SOURCE_SCHEMA_MISMATCH" ||
      executed.outcome === "SOURCE_VALUE_INVALID" ||
      executed.outcome === "SOURCE_INTEGRITY_FAILED"
    )
      return failure("SOURCE_INCONSISTENT");
    if (executed.outcome === "NUMERIC_OVERFLOW")
      return failure("QUERY_EXECUTION_FAILED");
    if (executed.outcome === "RESULT_LIMIT_EXCEEDED")
      return failure("RESULT_LIMIT_EXCEEDED");
    if (executed.outcome === "RESULT_SIZE_LIMIT_EXCEEDED")
      return failure("RESULT_TOO_LARGE");
    if (executed.outcome === "QUERY_TIMEOUT") return failure("QUERY_TIMEOUT");
    if (executed.outcome === "QUERY_CANCELLED")
      return failure("QUERY_CANCELLED");
    if (executed.outcome === "QUERY_OPERATIONAL_FAILURE")
      return failure("OPERATIONAL_FAILURE");
    return failure("INCONSISTENT_QUERY_PIPELINE");
  }

  const explained = buildQueryExplanation({
    resolvedQuery: resolved.query,
    result: executed.result,
  });
  if (explained.outcome !== "EXPLAINED")
    return failure("INCONSISTENT_QUERY_PIPELINE");
  return {
    outcome: "SUCCESS",
    execution: {
      result: executed.result,
      explanation: explained.explanation,
    },
  };
}
