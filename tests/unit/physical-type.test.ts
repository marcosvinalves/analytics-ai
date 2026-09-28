import { expect, test } from "vitest";
import {
  parsePhysicalType,
  supportedPhysicalType,
} from "../../src/modules/dataset/domain/physical-type.ts";

test.each([
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "FLOAT",
  "DOUBLE",
  "VARCHAR",
  "DATE",
  "TIME",
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMP WITH TIME ZONE",
  "UUID",
  "DECIMAL(1,0)",
  "DECIMAL(38,38)",
])("reconhece tipo físico persistido %s", (type) => {
  expect(supportedPhysicalType(type)).toBe(true);
  expect(parsePhysicalType(type)).toBeDefined();
});

test.each([
  "",
  "double",
  "NUMERIC",
  "JSON",
  "LIST(INTEGER)",
  "DECIMAL(0,0)",
  "DECIMAL(39,0)",
  "DECIMAL(10,11)",
  "DECIMAL(10,-1)",
  "DECIMAL(10)",
  "DECIMAL(10, 2)",
])("falha de forma segura para tipo físico não suportado %s", (type) => {
  expect(parsePhysicalType(type)).toBeUndefined();
  expect(supportedPhysicalType(type)).toBe(false);
});

test("preserva somente metadados físicos necessários", () => {
  expect(parsePhysicalType("BIGINT")).toEqual({
    family: "INTEGER",
    name: "BIGINT",
    decimalDigits: 19,
  });
  expect(parsePhysicalType("DECIMAL(20,2)")).toEqual({
    family: "DECIMAL",
    name: "DECIMAL(20,2)",
    precision: 20,
    scale: 2,
  });
});
