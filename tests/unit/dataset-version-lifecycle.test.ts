import { expect, test, vi } from "vitest";
import type { Pool } from "pg";
import {
  validateReady,
  validateFailed,
  SAFE_PROCESSING_MESSAGE,
  type ReadyInput,
  type FailedInput,
} from "../../src/modules/dataset/domain/dataset-version-lifecycle.ts";
import {
  markDatasetVersionReady,
  markDatasetVersionFailed,
} from "../../src/modules/dataset/infrastructure/dataset-version-lifecycle.ts";

const scope = {
  workspaceId: "a0000000-0000-4000-8000-000000000000",
  datasetVersionId: "b0000000-0000-4000-8000-000000000000",
};
test.each([-1, 0, 1.5, NaN, Infinity, 2147483648, undefined])(
  "rejeita columnCount %s",
  (columnCount) => {
    expect(() =>
      validateReady({
        ...scope,
        rowCount: BigInt(0),
        columnCount,
      } as ReadyInput),
    ).toThrow(TypeError);
  },
);
test.each([
  0,
  -1,
  1.5,
  NaN,
  undefined,
  "2",
  BigInt(-1),
  BigInt("9223372036854775808"),
])("rejeita rowCount inválido %s", (rowCount) => {
  expect(() =>
    validateReady({ ...scope, rowCount, columnCount: 1 } as ReadyInput),
  ).toThrow(TypeError);
});
test("aceita limites das contagens sem perda de precisão", () => {
  validateReady({ ...scope, rowCount: BigInt(0), columnCount: 1 });
  validateReady({
    ...scope,
    rowCount: BigInt("9223372036854775807"),
    columnCount: 2147483647,
  });
});
test.each([
  "",
  "lowercase",
  "A B",
  "A\nB",
  "A\n",
  "SELECT * FROM x",
  "A-1",
  "1_CODE",
  "Á",
  "A".repeat(65),
  new Error("secret"),
  undefined,
])("rejeita código inseguro %s", (errorCode) => {
  expect(() => validateFailed({ ...scope, errorCode } as FailedInput)).toThrow(
    TypeError,
  );
});
test.each([
  "CSV_PARSE_FAILED",
  "SCHEMA_INFERENCE_FAILED",
  "E_123",
  "A".repeat(64),
])("aceita código estrutural %s", (errorCode) => {
  validateFailed({ ...scope, errorCode });
  validateFailed({
    ...scope,
    errorCode,
    errorMessage: SAFE_PROCESSING_MESSAGE,
  });
  validateFailed({ ...scope, errorCode, errorMessage: null });
});
test.each(["SQL password=secret", "", new Error("secret"), 42])(
  "rejeita mensagem livre %s",
  (errorMessage) => {
    expect(() =>
      validateFailed({
        ...scope,
        errorCode: "FAILED",
        errorMessage,
      } as FailedInput),
    ).toThrow(TypeError);
  },
);
test("argumentos inválidos não chegam ao banco", async () => {
  const query = vi.fn();
  const pool = { query } as unknown as Pool;
  await expect(
    markDatasetVersionReady(pool, {
      ...scope,
      datasetVersionId: "bad",
      rowCount: BigInt(0),
      columnCount: 1,
    }),
  ).rejects.toThrow(TypeError);
  await expect(
    markDatasetVersionFailed(pool, {
      ...scope,
      workspaceId: "bad",
      errorCode: "FAILED",
    }),
  ).rejects.toThrow(TypeError);
  expect(query).not.toHaveBeenCalled();
});
test("erro do banco é seguro e não causa retry nem transição adicional", async () => {
  const query = vi.fn().mockRejectedValue(new Error("SQL password=secret"));
  await expect(
    markDatasetVersionFailed({ query } as unknown as Pool, {
      ...scope,
      errorCode: "FAILED",
    }),
  ).rejects.toThrow("LIFECYCLE_OUTCOME_UNKNOWN");
  expect(query).toHaveBeenCalledTimes(1);
});
