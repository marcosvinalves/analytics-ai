import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveLocalRaw } from "../../src/lib/storage/resolve-local-raw.ts";
import {
  ProcessingDataError,
  ProcessingOperationalError,
} from "../../src/modules/dataset/domain/dataset-profile.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("arquivo regular, traversal, ausência, symlink/junction e raiz indisponível", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raw-resolve-"));
  roots.push(root);
  const key =
    "workspaces/a0000000-0000-4000-8000-000000000000/versions/b0000000-0000-4000-8000-000000000000/raw.csv";
  const filename = path.join(root, key);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, "a\n1\n");
  const object = { namespace: "raw", key, sizeBytes: "4" };
  expect(await resolveLocalRaw(root, object, 10)).toBe(filename);
  await expect(
    resolveLocalRaw(root, { ...object, key: "../raw.csv" }, 10),
  ).rejects.toBeInstanceOf(ProcessingDataError);
  await expect(
    resolveLocalRaw(root, { ...object, sizeBytes: "5" }, 10),
  ).rejects.toBeInstanceOf(ProcessingDataError);
  await expect(resolveLocalRaw(root, object, 2)).rejects.toBeInstanceOf(
    ProcessingOperationalError,
  );
  await expect(
    resolveLocalRaw(path.join(root, "missing"), object, 10),
  ).rejects.toBeInstanceOf(ProcessingOperationalError);
  const link = path.join(root, "linked-root");
  await symlink(path.dirname(filename), link, "junction");
  await expect(resolveLocalRaw(link, object, 10)).rejects.toBeInstanceOf(
    ProcessingOperationalError,
  );
  await rm(filename);
  await expect(resolveLocalRaw(root, object, 10)).rejects.toBeInstanceOf(
    ProcessingDataError,
  );
});
