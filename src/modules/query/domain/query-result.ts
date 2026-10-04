import type { SemanticType } from "../../semantic/domain/semantic-field.ts";

export type QueryValue =
  | Readonly<{ type: "NULL" }>
  | Readonly<{ type: "STRING"; value: string }>
  | Readonly<{ type: "BOOLEAN"; value: boolean }>
  | Readonly<{ type: "INTEGER"; value: string }>
  | Readonly<{ type: "DECIMAL"; value: string }>
  | Readonly<{ type: "NUMBER"; value: string }>
  | Readonly<{ type: "DATE"; value: string }>
  | Readonly<{ type: "DATETIME"; value: string }>
  | Readonly<{ type: "INSTANT"; value: string }>;

export type QueryResultColumn = Readonly<{
  key: string;
  label: string;
  role: "DIMENSION" | "METRIC";
  semanticType: SemanticType;
}>;

export type QueryResultRow = readonly QueryValue[];

export type QueryResult = Readonly<{
  columns: readonly QueryResultColumn[];
  rows: readonly QueryResultRow[];
}>;
