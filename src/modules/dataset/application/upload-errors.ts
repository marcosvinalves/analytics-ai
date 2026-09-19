export class UploadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly cleanupAllowed: boolean;
  constructor(
    code: string,
    status: number,
    message: string,
    cleanupAllowed = false,
  ) {
    super(message);
    this.name = "UploadError";
    this.code = code;
    this.status = status;
    this.cleanupAllowed = cleanupAllowed;
  }
}

export function storageFailure(): UploadError {
  return new UploadError(
    "STORAGE_WRITE_FAILED",
    500,
    "Não foi possível armazenar o arquivo.",
  );
}
