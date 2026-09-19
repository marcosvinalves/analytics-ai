import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { receiveMultipart } from "../../src/modules/dataset/infrastructure/receive-multipart.ts";
import { LocalRawStorage } from "../../src/lib/storage/local-raw-storage.ts";
import { uploadRequest } from "../helpers/uploads.ts";

let root: string;
let storage: LocalRawStorage;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "multipart-test-"));
  storage = new LocalRawStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const signal = new AbortController().signal;

test("recebe um arquivo e campo name em streaming, preservando bytes", async () => {
  const result = await receiveMultipart(
    uploadRequest({ name: "Receita" }),
    storage,
    100,
    signal,
  );
  expect(result.name).toBe("Receita");
  expect(result.staged.sizeBytes).toBe(20);
  await storage.discard(result.staged);
});
test.each([
  [{ file: false }, "FILE_REQUIRED"],
  [{ bytes: "" }, "EMPTY_FILE"],
  [{ bytes: "x".repeat(101) }, "UPLOAD_TOO_LARGE"],
  [{ bytes: "x".repeat(101), contentLength: "1" }, "UPLOAD_TOO_LARGE"],
  [{ filename: "../x.csv" }, "INVALID_FILENAME"],
  [{ filename: "x.xlsx" }, "UNSUPPORTED_FILE_TYPE"],
  [{ mime: "image/png" }, "UNSUPPORTED_MEDIA_TYPE"],
  [{ extra: ["sourceType", "CSV"] as [string, string] }, "INVALID_MULTIPART"],
  [
    { extra: ["organizationId", "untrusted"] as [string, string] },
    "INVALID_MULTIPART",
  ],
])(
  "rejeita envelope inválido sem deixar temporários (%j)",
  async (options, code) => {
    await expect(
      receiveMultipart(uploadRequest(options), storage, 100, signal),
    ).rejects.toMatchObject({ code });
    const names = await readdir(path.join(root, ".staging")).catch(() => []);
    expect(names).toEqual([]);
  },
);
test("limite exato é aceito; MIME genérico não valida o conteúdo", async () => {
  const result = await receiveMultipart(
    uploadRequest({ bytes: "x".repeat(100), mime: "application/octet-stream" }),
    storage,
    100,
    signal,
  );
  expect(result.staged.sizeBytes).toBe(100);
  await storage.discard(result.staged);
});
test("multipart truncado falha", async () => {
  const valid = uploadRequest();
  const body = await valid.text();
  const truncated = new Request(valid.url, {
    method: "POST",
    headers: valid.headers,
    body: body.slice(0, -20),
  });
  await expect(
    receiveMultipart(truncated, storage, 100, signal),
  ).rejects.toMatchObject({ code: "INVALID_MULTIPART" });
});
test("timeout aborta recebimento sem corpo completo", async () => {
  const request = new Request("http://127.0.0.1/upload", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: new ReadableStream({ start() {} }),
    duplex: "half",
  } as RequestInit);
  await expect(
    receiveMultipart(request, storage, 100, AbortSignal.timeout(50)),
  ).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT" });
});
