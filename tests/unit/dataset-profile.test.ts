import { expect, test } from "vitest";
import {
  validateDatasetProfile,
  ProcessingOperationalError,
  type DatasetProfile,
} from "../../src/modules/dataset/domain/dataset-profile.ts";
import { isDeterministicCsvError } from "../../src/modules/dataset/infrastructure/inspect-csv.ts";
const profile = (): DatasetProfile => ({
  rowCount: BigInt(2),
  columns: [
    {
      physicalName: "x",
      inferredType: "DOUBLE",
      ordinalPosition: 1,
      nullCount: BigInt(0),
      nullable: null,
    },
  ],
});
test("sem NULL observado não implica NOT NULL; perfil mínimo preserva DOUBLE", () => {
  validateDatasetProfile(profile());
  const value = profile();
  value.columns[0].nullable = false as never;
  expect(() => validateDatasetProfile(value)).toThrow(
    ProcessingOperationalError,
  );
  value.columns[0].nullable = true;
  value.columns[0].nullCount = BigInt(1);
  validateDatasetProfile(value);
});
test("rejeita contagens, ordem e nomes inconsistentes", () => {
  for (const mutate of [
    (p: DatasetProfile) => {
      p.rowCount = BigInt(-1);
    },
    (p: DatasetProfile) => {
      p.columns[0].nullCount = BigInt(3);
    },
    (p: DatasetProfile) => {
      p.columns[0].physicalName = " ";
    },
    (p: DatasetProfile) => {
      p.columns[0].ordinalPosition = 2;
    },
    (p: DatasetProfile) => {
      p.columns.push({ ...p.columns[0], ordinalPosition: 2 });
    },
  ]) {
    const p = profile();
    mutate(p);
    expect(() => validateDatasetProfile(p)).toThrow(ProcessingOperationalError);
  }
});
test("classificação conservadora não condena dados por OOM/IO/runtime", () => {
  for (const error of [
    new Error("out of memory"),
    new Error(
      JSON.stringify({
        exception_type: "Out of Memory",
        exception_message: "CSV Error on Line: 1",
      }),
    ),
    new Error(
      JSON.stringify({
        exception_type: "IO",
        exception_message: "File unavailable",
      }),
    ),
    new Error(
      JSON.stringify({
        exception_type: "Invalid Input",
        exception_message: "Unknown setting",
      }),
    ),
    {},
  ])
    expect(isDeterministicCsvError(error)).toBe(false);
  expect(
    isDeterministicCsvError(
      new Error(
        JSON.stringify({
          exception_type: "Invalid Input",
          exception_message: 'Error when sniffing file "private"',
        }),
      ),
    ),
  ).toBe(true);
});
