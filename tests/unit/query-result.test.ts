import {
  DuckDBDecimalValue,
  dateValue,
  timestampTZValue,
  timestampValue,
} from "@duckdb/node-api";
import { describe, expect, test, vi } from "vitest";
import { serializeQueryValue } from "../../src/modules/query/infrastructure/duckdb-query-executor.ts";

vi.mock("server-only", () => ({}));

describe("QueryValue serialization", () => {
  test("preserves exact integers and DECIMAL scale without Number", () => {
    expect(
      serializeQueryValue(BigInt("9223372036854775808"), { kind: "INTEGER" }),
    ).toEqual({
      type: "INTEGER",
      value: "9223372036854775808",
    });
    expect(
      serializeQueryValue(BigInt("-170141183460469231731687303715884105727"), {
        kind: "INTEGER",
      }),
    ).toEqual({
      type: "INTEGER",
      value: "-170141183460469231731687303715884105727",
    });
    expect(
      serializeQueryValue(new DuckDBDecimalValue(BigInt(205961), 38, 2), {
        kind: "DECIMAL",
        precision: 38,
        scale: 2,
      }),
    ).toEqual({ type: "DECIMAL", value: "2059.61" });
    expect(
      serializeQueryValue(new DuckDBDecimalValue(BigInt(0), 38, 2), {
        kind: "DECIMAL",
        precision: 38,
        scale: 2,
      }),
    ).toEqual({ type: "DECIMAL", value: "0.00" });
    expect(
      serializeQueryValue(new DuckDBDecimalValue(BigInt(-120), 38, 2), {
        kind: "DECIMAL",
        precision: 38,
        scale: 2,
      }),
    ).toEqual({ type: "DECIMAL", value: "-1.20" });
  });

  test("serializes finite NUMBER deterministically and rejects non-finite values", () => {
    expect(serializeQueryValue(-0, { kind: "NUMBER" })).toEqual({
      type: "NUMBER",
      value: "0",
    });
    expect(serializeQueryValue(1.25, { kind: "NUMBER" })).toEqual({
      type: "NUMBER",
      value: "1.25",
    });
    expect(() => serializeQueryValue(Number.NaN, { kind: "NUMBER" })).toThrow();
    expect(() =>
      serializeQueryValue(Number.POSITIVE_INFINITY, { kind: "NUMBER" }),
    ).toThrow();
  });

  test("preserves date and microseconds without JavaScript Date", () => {
    expect(
      serializeQueryValue(dateValue({ year: 2024, month: 2, day: 29 }), {
        kind: "DATE",
      }),
    ).toEqual({
      type: "DATE",
      value: "2024-02-29",
    });
    const parts = {
      date: { year: 2024, month: 1, day: 2 },
      time: { hour: 3, min: 4, sec: 5, micros: 123400 },
    };
    expect(
      serializeQueryValue(timestampValue(parts), { kind: "DATETIME" }),
    ).toEqual({
      type: "DATETIME",
      value: "2024-01-02T03:04:05.1234",
    });
    expect(
      serializeQueryValue(timestampTZValue(parts), { kind: "INSTANT" }),
    ).toEqual({
      type: "INSTANT",
      value: "2024-01-02T03:04:05.1234Z",
    });
  });

  test("serializes NULL, BOOLEAN and STRING without normalization", () => {
    expect(serializeQueryValue(null, { kind: "STRING" })).toEqual({
      type: "NULL",
    });
    expect(serializeQueryValue(true, { kind: "BOOLEAN" })).toEqual({
      type: "BOOLEAN",
      value: true,
    });
    expect(serializeQueryValue(" Ação ", { kind: "STRING" })).toEqual({
      type: "STRING",
      value: " Ação ",
    });
    expect(() => serializeQueryValue("a\0b", { kind: "STRING" })).toThrow();
  });

  test("rejects physical wrappers inconsistent with semantic output", () => {
    expect(() =>
      serializeQueryValue(new DuckDBDecimalValue(BigInt(1), 18, 2), {
        kind: "DECIMAL",
        precision: 38,
        scale: 2,
      }),
    ).toThrow();
    expect(() => serializeQueryValue("1", { kind: "INTEGER" })).toThrow();
  });
});
