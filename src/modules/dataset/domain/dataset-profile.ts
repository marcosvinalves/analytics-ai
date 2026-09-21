export type DatasetProfile = {
  rowCount: bigint;
  columns: {
    physicalName: string;
    inferredType: string;
    ordinalPosition: number;
    nullCount: bigint;
    nullable: true | null;
  }[];
};
export type ProcessingFailureCode =
  "RAW_OBJECT_UNAVAILABLE" | "CSV_READ_FAILED";
/** Only known deterministic input failures; never construct with an engine/OS error message. */
export class ProcessingDataError extends Error {
  readonly code: ProcessingFailureCode;
  constructor(code: ProcessingFailureCode) {
    super("O arquivo não pode ser processado segundo o contrato CSV.");
    this.code = code;
  }
}
export class ProcessingOperationalError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(outcomeUnknown = false) {
    super(
      "Não foi possível concluir o processamento. Verifique o estado antes de uma nova tentativa explícita.",
    );
    this.outcomeUnknown = outcomeUnknown;
  }
}
export function validateDatasetProfile(profile: DatasetProfile): void {
  const max = BigInt("9223372036854775807");
  if (
    typeof profile.rowCount !== "bigint" ||
    profile.rowCount < BigInt(0) ||
    profile.rowCount > max ||
    !profile.columns.length ||
    profile.columns.length > 2147483647
  )
    throw new ProcessingOperationalError();
  const names = new Set<string>();
  profile.columns.forEach((column, index) => {
    if (
      typeof column.physicalName !== "string" ||
      !column.physicalName.trim() ||
      column.physicalName.includes("\0") ||
      names.has(column.physicalName) ||
      typeof column.inferredType !== "string" ||
      !column.inferredType.trim() ||
      column.inferredType.includes("\0") ||
      column.ordinalPosition !== index + 1 ||
      typeof column.nullCount !== "bigint" ||
      column.nullCount < BigInt(0) ||
      column.nullCount > profile.rowCount ||
      column.nullable !== (column.nullCount > BigInt(0) ? true : null)
    )
      throw new ProcessingOperationalError();
    names.add(column.physicalName);
  });
}
