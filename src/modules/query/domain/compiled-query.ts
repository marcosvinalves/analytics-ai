import type {
  AnalyticalMaterialHandle,
  AnalyticalMaterialIdentity,
} from "../../dataset/domain/analytical-source.ts";
import type { OutputDescriptor } from "./physical-query-plan.ts";

export type CompilationFailureCode =
  "SOURCE_SCHEMA_MISMATCH" | "SOURCE_VALUE_INVALID" | "NUMERIC_OVERFLOW";

export type CompiledParameter =
  | Readonly<{ kind: "MATERIAL_PATH" }>
  | Readonly<{ kind: "VARCHAR"; value: string }>
  | Readonly<{ kind: "BOOLEAN"; value: boolean }>;

export type CompiledStatement = Readonly<{
  sql: string;
  parameters: readonly CompiledParameter[];
  engineErrorMappings: readonly Readonly<{
    exceptionType: "Invalid Input" | "Out of Range";
    failureCode: CompilationFailureCode;
  }>[];
}>;

export type CompiledValidationCommand = Readonly<{
  kind:
    | "SOURCE_SCHEMA"
    | "SOURCE_ROW_COUNT"
    | "SOURCE_VALUE"
    | "LITERAL_CAPABILITY"
    | "RESULT_VALUE";
  purpose:
    | "VALIDATE_CSV_HEADER"
    | "VALIDATE_EXPECTED_ROW_COUNT"
    | "VALIDATE_USED_SOURCE_FIELDS"
    | "VALIDATE_LITERAL_ENGINE_CAPABILITY"
    | "VALIDATE_FINITE_DOUBLE_RESULTS";
  statement: CompiledStatement;
  result:
    | Readonly<{
        kind: "BOOLEAN";
        resultAlias: "valid";
        failureCode: CompilationFailureCode;
      }>
    | Readonly<{
        kind: "VIOLATION_COUNTS";
        checks: readonly Readonly<{
          resultAlias: string;
          failureCode: CompilationFailureCode;
          sourceFieldIndex?: number;
          outputIndex?: number;
        }>[];
      }>;
}>;

export type CompiledQuery = Readonly<{
  version: 1;
  material: AnalyticalMaterialHandle;
  materialIdentity: AnalyticalMaterialIdentity;
  sessionRequirements: Readonly<{ timeZone: "UTC" }>;
  lifecycle: Readonly<{
    connection: "DEDICATED_PER_EXECUTION";
    temporaryObject: "__t018_source";
    cleanup: "CLOSE_CONNECTION";
  }>;
  sourceValidations: readonly CompiledValidationCommand[];
  preparation: Readonly<{
    kind: "SOURCE_MATERIALIZATION";
    purpose: "MATERIALIZE_CSV_AS_TEXT";
    statement: CompiledStatement;
  }>;
  validations: readonly CompiledValidationCommand[];
  query: CompiledStatement;
  outputs: readonly OutputDescriptor[];
}>;

export type CompilePhysicalQueryResult =
  | Readonly<{ outcome: "COMPILED"; compiledQuery: CompiledQuery }>
  | Readonly<{ outcome: "INCONSISTENT_PHYSICAL_PLAN"; path: string }>
  | Readonly<{ outcome: "UNSUPPORTED_COMPILATION"; feature: string }>;
