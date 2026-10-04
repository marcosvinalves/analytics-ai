import { expect, test, vi } from "vitest";
import type { AnalyticalMaterialHandle } from "../../src/modules/dataset/domain/analytical-source.ts";
import { executeCompiledQuery } from "../../src/modules/query/application/execute-compiled-query.ts";
import type { CompiledQuery } from "../../src/modules/query/domain/compiled-query.ts";
import type { CompiledStatement } from "../../src/modules/query/domain/compiled-query.ts";
import { structuredEngineFailure } from "../../src/modules/query/infrastructure/duckdb-query-executor.ts";

vi.mock("server-only", () => ({}));

test("rejects a structurally forged CompiledQuery before material resolution", async () => {
  const forged = {
    version: 1,
    material: Object.freeze({}) as AnalyticalMaterialHandle,
    materialIdentity: {
      device: BigInt(1),
      inode: BigInt(2),
      sizeBytes: BigInt(3),
      modifiedTimeNs: BigInt(4),
    },
    sessionRequirements: { timeZone: "UTC" },
    lifecycle: {
      connection: "DEDICATED_PER_EXECUTION",
      temporaryObject: "__t018_source",
      cleanup: "CLOSE_CONNECTION",
    },
    sourceValidations: [],
    preparation: {
      kind: "SOURCE_MATERIALIZATION",
      purpose: "MATERIALIZE_CSV_AS_TEXT",
      statement: { sql: "SELECT 1", parameters: [], engineErrorMappings: [] },
    },
    validations: [],
    query: { sql: "SELECT 1 AS o0", parameters: [], engineErrorMappings: [] },
    outputs: [],
  } as unknown as CompiledQuery;
  await expect(executeCompiledQuery(forged)).resolves.toEqual({
    outcome: "INCONSISTENT_COMPILED_QUERY",
  });
});

test("pre-aborted signal returns cancellation without touching the forged capability", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    executeCompiledQuery({} as CompiledQuery, { signal: controller.signal }),
  ).resolves.toEqual({ outcome: "QUERY_CANCELLED" });
});

test("maps only structured exception_type declared by the active statement", () => {
  const statement: CompiledStatement = {
    sql: "compiler-owned",
    parameters: [],
    engineErrorMappings: [
      { exceptionType: "Out of Range", failureCode: "NUMERIC_OVERFLOW" },
    ],
  };
  expect(
    structuredEngineFailure(
      statement,
      new Error(
        JSON.stringify({
          exception_type: "Out of Range",
          exception_message: "private",
        }),
      ),
    ),
  ).toBe("NUMERIC_OVERFLOW");
  expect(
    structuredEngineFailure(
      statement,
      new Error(
        JSON.stringify({
          exception_type: "Binder",
          exception_message: "Out of Range must not be inspected",
        }),
      ),
    ),
  ).toBeUndefined();
  expect(
    structuredEngineFailure(statement, new Error("Out of Range")),
  ).toBeUndefined();
});
