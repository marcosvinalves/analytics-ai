import { expect, test } from "vitest";
import {
  validateFilename,
  datasetName,
} from "../../src/modules/dataset/domain/upload-validation.ts";
import { rawStorageKey, validRawKey } from "../../src/lib/storage/key.ts";

test.each(["vendas.csv", "VENDAS.CSV", "vendas de setembro.csv"])(
  "aceita %s",
  (name) => {
    expect(validateFilename(name, "text/csv")).toBe(name);
  },
);
test.each([
  "",
  "../vendas.csv",
  "..\\vendas.csv",
  "C:\\vendas.csv",
  "vendas.csv\u0000",
  "x.csv.exe",
  "x.png",
  "a".repeat(256) + ".csv",
])("rejeita nome %s", (name) => {
  expect(() => validateFilename(name, "text/csv")).toThrow();
});
test.each([
  "",
  "application/octet-stream",
  "text/plain",
  "application/vnd.ms-excel",
  "application/csv",
])("MIME %s é indicação compatível, não prova de CSV", (mime) => {
  expect(validateFilename("x.csv", mime)).toBe("x.csv");
});
test("MIME explicitamente incompatível é rejeitado", () => {
  expect(() => validateFilename("x.csv", "image/png")).toThrow();
});
test("nome é apresentação e não identidade", () => {
  expect(datasetName(undefined, "vendas.csv")).toBe("vendas");
  expect(datasetName(" Receita ", "vendas.csv")).toBe("Receita");
  expect(() => datasetName("x".repeat(201), "x.csv")).toThrow();
  const key = rawStorageKey(
    "a0000000-0000-4000-8000-000000000000",
    "b0000000-0000-4000-8000-000000000000",
  );
  expect(validRawKey(key)).toBe(true);
  expect(validRawKey("../../x.csv")).toBe(false);
});
