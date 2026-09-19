import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { storageConfig } from "../../src/lib/storage/config.ts";

afterEach(() => vi.unstubAllEnvs());

test("limite Alpha configurável e storage fora do diretório público", () => {
  vi.stubEnv("MAX_UPLOAD_BYTES", "10485760");
  vi.stubEnv("LOCAL_STORAGE_ROOT", ".local/raw-storage");
  expect(storageConfig().maxBytes).toBe(10 * 1024 * 1024);
  expect(storageConfig().root).toBe(path.resolve(".local/raw-storage"));
  vi.stubEnv("LOCAL_STORAGE_ROOT", "public/uploads");
  expect(() => storageConfig()).toThrow("fora do diretório public");
  vi.stubEnv("LOCAL_STORAGE_ROOT", ".local/raw-storage");
  vi.stubEnv("MAX_UPLOAD_BYTES", "-1");
  expect(() => storageConfig()).toThrow("inteiro positivo");
});
