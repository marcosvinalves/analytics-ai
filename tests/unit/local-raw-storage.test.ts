import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  symlink,
  mkdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LocalRawStorage } from "../../src/lib/storage/local-raw-storage.ts";
import { rawStorageKey } from "../../src/lib/storage/key.ts";

let root: string;
let storage: LocalRawStorage;
const key = rawStorageKey(
  "a0000000-0000-4000-8000-000000000000",
  "b0000000-0000-4000-8000-000000000000",
);
const signal = new AbortController().signal;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "raw-storage-test-"));
  storage = new LocalRawStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function* bytes(text: string) {
  yield Buffer.from(text);
}

test("publica bytes sem alterar e nunca sobrescreve uma colisão", async () => {
  const first = await storage.stage(bytes("original\r\n"), signal);
  const object = await storage.publishOnce(first, key);
  const second = await storage.stage(bytes("replacement"), signal);
  await expect(storage.publishOnce(second, key)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await storage.discard(second);
  expect(await readFile(path.join(root, key), "utf8")).toBe("original\r\n");
  expect(await readdir(path.join(root, ".staging"))).toEqual([]);
  await storage.remove(object);
  await expect(readFile(path.join(root, key))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("erro no stream remove o temporário", async () => {
  async function* broken() {
    yield Buffer.from("partial");
    throw new Error("broken");
  }
  await expect(storage.stage(broken(), signal)).rejects.toThrow();
  expect(await readdir(path.join(root, ".staging"))).toEqual([]);
});
test("rejeita paths externos e links em diretórios do storage", async () => {
  const staged = await storage.stage(bytes("content"), signal);
  await expect(storage.publishOnce(staged, "../outside.csv")).rejects.toThrow();
  const outside = path.join(root, "target");
  await mkdir(outside);
  await symlink(outside, path.join(root, "workspaces"), "junction");
  await expect(storage.publishOnce(staged, key)).rejects.toThrow();
  await storage.discard(staged);
  expect(await readdir(outside)).toEqual([]);
});
