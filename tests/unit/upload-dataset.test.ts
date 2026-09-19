import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { uploadDataset } from "../../src/modules/dataset/application/upload-dataset.ts";
import { UploadError } from "../../src/modules/dataset/application/upload-errors.ts";
import { LocalRawStorage } from "../../src/lib/storage/local-raw-storage.ts";
import { uploadRequest } from "../helpers/uploads.ts";

let root: string;
let storage: LocalRawStorage;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "upload-test-"));
  storage = new LocalRawStorage(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function options(persist = vi.fn(async () => {})) {
  return {
    workspaceId: "a0000000-0000-4000-8000-000000000000",
    organizationId: "c0000000-0000-4000-8000-000000000000",
    storage,
    maxBytes: 100,
    signal: new AbortController().signal,
    requestId: "test",
    persist,
  };
}
async function rawFiles() {
  return (await readdir(root, { recursive: true })).filter((name) =>
    name.endsWith("raw.csv"),
  );
}
test("persiste somente depois de publicar", async () => {
  const persist = vi.fn(async () => {
    expect(await rawFiles()).toHaveLength(1);
  });
  const result = await uploadDataset(uploadRequest(), options(persist));
  expect(persist).toHaveBeenCalledOnce();
  expect(result.version.status).toBe("PROCESSING");
  expect(result.version.sourceType).toBe("CSV");
});
test("rollback confirmado remove somente o novo objeto", async () => {
  const persist = vi.fn(async () => {
    throw new UploadError("METADATA_WRITE_FAILED", 503, "Falha", true);
  });
  await expect(
    uploadDataset(uploadRequest(), options(persist)),
  ).rejects.toMatchObject({ code: "METADATA_WRITE_FAILED" });
  expect(await rawFiles()).toEqual([]);
});
test("commit incerto preserva o objeto", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const persist = vi.fn(async () => {
    throw new UploadError("UPLOAD_OUTCOME_UNKNOWN", 503, "Incerto");
  });
  await expect(
    uploadDataset(uploadRequest(), options(persist)),
  ).rejects.toMatchObject({ code: "UPLOAD_OUTCOME_UNKNOWN" });
  expect(await rawFiles()).toHaveLength(1);
});
test("falha na publicação não grava metadados nem remove objeto preexistente", async () => {
  vi.spyOn(storage, "publishOnce").mockRejectedValue(new Error("disk error"));
  const remove = vi.spyOn(storage, "remove");
  const opts = options();
  await expect(uploadDataset(uploadRequest(), opts)).rejects.toMatchObject({
    code: "STORAGE_WRITE_FAILED",
  });
  expect(opts.persist).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(await readdir(path.join(root, ".staging"))).toEqual([]);
});
test("falha na compensação não transforma falha em sucesso", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(storage, "remove").mockRejectedValue(new Error("disk"));
  const persist = vi.fn(async () => {
    throw new UploadError("METADATA_WRITE_FAILED", 503, "Falha", true);
  });
  await expect(
    uploadDataset(uploadRequest(), options(persist)),
  ).rejects.toMatchObject({ code: "METADATA_WRITE_FAILED" });
  expect(await rawFiles()).toHaveLength(1);
});
