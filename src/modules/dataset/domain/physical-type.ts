const INTEGER_DIGITS = {
  TINYINT: 3,
  SMALLINT: 5,
  INTEGER: 10,
  BIGINT: 19,
  HUGEINT: 38,
  UTINYINT: 3,
  USMALLINT: 5,
  UINTEGER: 10,
  UBIGINT: 20,
  UHUGEINT: 39,
} as const;

type IntegerName = keyof typeof INTEGER_DIGITS;
type TimestampName =
  "TIMESTAMP" | "TIMESTAMP_S" | "TIMESTAMP_MS" | "TIMESTAMP_NS";

export type PhysicalType =
  | { family: "BOOLEAN"; name: "BOOLEAN" }
  | { family: "INTEGER"; name: IntegerName; decimalDigits: number }
  | { family: "NUMBER"; name: "FLOAT" | "DOUBLE" }
  | { family: "DECIMAL"; name: string; precision: number; scale: number }
  | { family: "STRING"; name: "VARCHAR" }
  | { family: "DATE"; name: "DATE" }
  | { family: "DATETIME"; name: TimestampName }
  | { family: "INSTANT"; name: "TIMESTAMP WITH TIME ZONE" }
  | { family: "TIME"; name: "TIME" }
  | { family: "UUID"; name: "UUID" };

export function parsePhysicalType(value: string): PhysicalType | undefined {
  if (value === "BOOLEAN") return { family: "BOOLEAN", name: value };
  if (value in INTEGER_DIGITS) {
    const name = value as IntegerName;
    return {
      family: "INTEGER",
      name,
      decimalDigits: INTEGER_DIGITS[name],
    };
  }
  if (value === "FLOAT" || value === "DOUBLE")
    return { family: "NUMBER", name: value };
  if (value === "VARCHAR") return { family: "STRING", name: value };
  if (value === "DATE") return { family: "DATE", name: value };
  if (
    value === "TIMESTAMP" ||
    value === "TIMESTAMP_S" ||
    value === "TIMESTAMP_MS" ||
    value === "TIMESTAMP_NS"
  )
    return { family: "DATETIME", name: value };
  if (value === "TIMESTAMP WITH TIME ZONE")
    return { family: "INSTANT", name: value };
  if (value === "TIME") return { family: "TIME", name: value };
  if (value === "UUID") return { family: "UUID", name: value };
  const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(value);
  if (!decimal) return undefined;
  const precision = Number(decimal[1]);
  const scale = Number(decimal[2]);
  if (precision < 1 || precision > 38 || scale > precision) return undefined;
  return { family: "DECIMAL", name: value, precision, scale };
}

export function supportedPhysicalType(value: string): boolean {
  return parsePhysicalType(value) !== undefined;
}
