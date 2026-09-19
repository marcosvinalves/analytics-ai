import busboy from "busboy";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type {
  RawStorage,
  StagedRaw,
} from "../../../lib/storage/raw-storage.ts";
import { UploadError, storageFailure } from "../application/upload-errors.ts";
import { validateFilename, datasetName } from "../domain/upload-validation.ts";

const malformed = () =>
  new UploadError(
    "INVALID_MULTIPART",
    400,
    "Envie um arquivo e, opcionalmente, o nome do dataset.",
  );
const tooLarge = () =>
  new UploadError(
    "UPLOAD_TOO_LARGE",
    413,
    "O arquivo ou a requisição excede o limite permitido.",
  );

export async function receiveMultipart(
  request: Request,
  storage: RawStorage,
  maxBytes: number,
  signal: AbortSignal,
) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body)
    throw malformed();
  if (
    request.headers.has("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  )
    throw malformed();
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw malformed();
    if (Number(length) > maxBytes + 65536) throw tooLarge();
  }
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": contentType },
      preservePath: true,
      defParamCharset: "utf8",
      limits: {
        files: 1,
        fields: 1,
        parts: 3,
        fileSize: maxBytes + 1,
        fieldSize: 800,
        fieldNameSize: 32,
        headerPairs: 32,
      },
    });
  } catch {
    throw malformed();
  }
  let failure: UploadError | undefined;
  let filename: string | undefined;
  let name: string | undefined;
  let activeFile: Readable | undefined;
  let stageTask: Promise<StagedRaw | undefined> | undefined;
  let staged: StagedRaw | undefined;
  const fail = (error: UploadError) => {
    failure ??= error;
    // Busboy continues its current callback after emitting a limit event.
    // Defer destruction so its internal file stream isn't nulled mid-callback.
    queueMicrotask(() => {
      activeFile?.destroy(error);
      parser.destroy(error);
    });
  };
  parser.on("file", (field, file, info) => {
    activeFile = file;
    // Attach before any rejection, including invalid multipart field names.
    file.on("error", () => {
      failure ??= malformed();
    });
    try {
      if (field !== "file" || filename !== undefined) throw malformed();
      filename = validateFilename(info.filename, info.mimeType);
    } catch (error) {
      fail(error instanceof UploadError ? error : malformed());
      return;
    }
    file.on("limit", () => fail(tooLarge()));
    async function* boundedFile() {
      let size = 0;
      for await (const chunk of file) {
        size += (chunk as Buffer).byteLength;
        if (size > maxBytes) throw tooLarge();
        yield chunk as Buffer;
      }
    }
    stageTask = storage
      .stage(boundedFile(), signal)
      .then((result) => {
        staged = result;
        return result;
      })
      .catch((error) => {
        fail(
          error instanceof UploadError ? error : failure || storageFailure(),
        );
        return undefined;
      });
  });
  parser.on("field", (field, value, info) => {
    if (
      field !== "name" ||
      name !== undefined ||
      info.valueTruncated ||
      info.nameTruncated
    )
      fail(malformed());
    else name = value;
  });
  for (const event of ["filesLimit", "fieldsLimit", "partsLimit"] as const)
    parser.on(event, () => fail(malformed()));
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(bytes > maxBytes + 65536 ? tooLarge() : null, chunk);
    },
  });
  const onAbort = () =>
    fail(
      new UploadError(
        signal.reason?.name === "TimeoutError"
          ? "UPLOAD_TIMEOUT"
          : "UPLOAD_ABORTED",
        signal.reason?.name === "TimeoutError" ? 408 : 400,
        "O recebimento do arquivo foi interrompido.",
      ),
    );
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await pipeline(
      Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>),
      counter,
      parser,
      { signal },
    );
    await stageTask;
    if (failure) throw failure;
    if (!filename || !staged)
      throw new UploadError("FILE_REQUIRED", 400, "Selecione um arquivo CSV.");
    if (staged.sizeBytes === 0)
      throw new UploadError("EMPTY_FILE", 400, "O arquivo está vazio.");
    return {
      staged,
      originalFilename: filename,
      name: datasetName(name, filename),
    };
  } catch (error) {
    if (signal.aborted) onAbort();
    // Destroy any open file stream so disk writes settle before cleanup.
    activeFile?.destroy(
      error instanceof Error ? error : new Error("Invalid multipart"),
    );
    await stageTask;
    if (staged)
      await storage
        .discard(staged)
        .catch(() => console.error("RAW_STAGE_CLEANUP_FAILED"));
    throw failure || (error instanceof UploadError ? error : malformed());
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
