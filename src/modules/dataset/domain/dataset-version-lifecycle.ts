export const SAFE_PROCESSING_MESSAGE = "Não foi possível processar o dataset.";

export type VersionScope = { workspaceId: string; datasetVersionId: string };
export type ReadyInput = VersionScope & {
  rowCount: bigint;
  columnCount: number;
};
export type FailedInput = VersionScope & {
  errorCode: string;
  errorMessage?: typeof SAFE_PROCESSING_MESSAGE | null;
};
export type LifecycleSnapshot = {
  id: string;
  status: "READY" | "FAILED";
  rowCount: bigint | null;
  columnCount: number | null;
  processingErrorCode: string | null;
  processingErrorMessage: string | null;
  processedAt: Date;
  updatedAt: Date;
};
export type TransitionResult =
  | { outcome: "TRANSITIONED"; version: LifecycleSnapshot }
  | { outcome: "NOT_FOUND" }
  | { outcome: "ALREADY_TERMINAL"; status: "READY" | "FAILED" };

function invalid(): never {
  throw new TypeError(
    "Argumentos inválidos para finalizar a versão do dataset.",
  );
}
function validateScope(input: VersionScope) {
  if (!input || typeof input !== "object") invalid();
  for (const value of [input.workspaceId, input.datasetVersionId]) {
    if (
      typeof value !== "string" ||
      value.length !== 36 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    )
      invalid();
  }
}
export function validateReady(input: ReadyInput): void {
  validateScope(input);
  if (
    typeof input.rowCount !== "bigint" ||
    input.rowCount < BigInt(0) ||
    input.rowCount > BigInt("9223372036854775807")
  )
    invalid();
  if (
    !Number.isInteger(input.columnCount) ||
    input.columnCount < 1 ||
    input.columnCount > 2147483647
  )
    invalid();
}
export function validateFailed(input: FailedInput): void {
  validateScope(input);
  // Machine code only: no coercion, free text, Error objects or exception messages.
  if (
    typeof input.errorCode !== "string" ||
    input.errorCode !== input.errorCode.trim() ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)
  )
    invalid();
  if (
    input.errorMessage != null &&
    input.errorMessage !== SAFE_PROCESSING_MESSAGE
  )
    invalid();
}
