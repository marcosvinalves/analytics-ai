export const GROUND_TRUTH_SAFE_MESSAGE =
  "Não foi possível executar a agregação de referência. Nenhum dado foi alterado.";

export type GroundTruthErrorCode =
  | "GROUND_TRUTH_SCHEMA_INVALID"
  | "GROUND_TRUTH_INPUT_INVALID"
  | "GROUND_TRUTH_OVERFLOW"
  | "GROUND_TRUTH_READ_FAILED"
  | "GROUND_TRUTH_OPERATIONAL_FAILURE";

export type GroundTruthAggregationResult =
  | {
      outcome: "SUCCESS";
      value: string | null;
      type: "DECIMAL(38,2)";
      rowCount: string;
      contributingRows: string;
    }
  | { outcome: "NOT_FOUND" }
  | { outcome: "NOT_READY"; status: "PROCESSING" | "FAILED" }
  | {
      outcome: "ERROR";
      code: GroundTruthErrorCode;
      message: typeof GROUND_TRUTH_SAFE_MESSAGE;
    };

export class GroundTruthError extends Error {
  readonly code: GroundTruthErrorCode;
  constructor(code: GroundTruthErrorCode) {
    super(GROUND_TRUTH_SAFE_MESSAGE);
    this.code = code;
  }
}
