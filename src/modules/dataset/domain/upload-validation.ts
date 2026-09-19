import { UploadError } from "../application/upload-errors.ts";

const mimeTypes = new Set([
  "",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

export function validateFilename(filename: string, mime: string): string {
  if (
    !filename ||
    filename.length > 255 ||
    /[\\/\x00-\x1f\x7f]/.test(filename) ||
    filename.trim() !== filename ||
    filename === "." ||
    filename === ".."
  ) {
    throw new UploadError(
      "INVALID_FILENAME",
      400,
      "O nome do arquivo é inválido.",
    );
  }
  if (!/^.+\.csv$/i.test(filename))
    throw new UploadError(
      "UNSUPPORTED_FILE_TYPE",
      415,
      "Selecione um arquivo com extensão .csv.",
    );
  if (!mimeTypes.has(mime.split(";")[0].trim().toLowerCase())) {
    throw new UploadError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "O tipo declarado do arquivo não é aceito.",
    );
  }
  return filename;
}

export function datasetName(
  value: string | undefined,
  filename: string,
): string {
  const name = value?.trim() || filename.slice(0, -4).trim();
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new UploadError(
      "INVALID_DATASET_NAME",
      400,
      "Informe um nome de dataset com até 200 caracteres.",
    );
  }
  return name;
}
