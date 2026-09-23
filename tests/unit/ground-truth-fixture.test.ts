import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

function cents(value: string): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match)
    throw new Error("Fixture decimal outside independent oracle contract");
  const magnitude =
    BigInt(match[2]) * BigInt(100) + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

test("fixture synthetic expected is independently derived with BigInt cents", async () => {
  const csv = await readFile(
    "tests/fixtures/ground-truth/synthetic.csv",
    "utf8",
  );
  const expected = JSON.parse(
    await readFile("tests/fixtures/ground-truth/expected.json", "utf8"),
  );
  const rows = csv
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/\r$/, "").split(","));
  let total = BigInt(0);
  let contributing = 0;
  for (const [quantity, price] of rows) {
    if (!quantity || !price) continue;
    total += BigInt(quantity) * cents(price);
    contributing++;
  }
  expect(total.toString()).toBe(expected.expectedCents);
  expect(
    `${total < 0 ? "-" : ""}${(total < 0 ? -total : total) / BigInt(100)}.${((total < 0 ? -total : total) % BigInt(100)).toString().padStart(2, "0")}`,
  ).toBe(expected.expectedValue);
  expect(String(rows.length)).toBe(expected.rowCount);
  expect(String(contributing)).toBe(expected.contributingRows);
});
