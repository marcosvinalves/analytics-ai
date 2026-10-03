import type { PhysicalType } from "./physical-type.ts";

declare const analyticalMaterialBrand: unique symbol;
declare const authorizedSourceBrand: unique symbol;

/** Opaque local material resolved by trusted dataset infrastructure. */
export type AnalyticalMaterialHandle = Readonly<{
  [analyticalMaterialBrand]: true;
}>;

export type AnalyticalMaterialIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  sizeBytes: bigint;
  modifiedTimeNs: bigint;
}>;

export type AuthorizedAnalyticalSource = Readonly<{
  [authorizedSourceBrand]: true;
  datasetId: string;
  datasetVersionId: string;
  sourceType: string;
  material: AnalyticalMaterialHandle;
  materialIdentity: AnalyticalMaterialIdentity;
  expectedSizeBytes: bigint;
  expectedRowCount: bigint;
  schema: readonly Readonly<{
    physicalName: string;
    physicalType: PhysicalType;
    ordinalPosition: number;
  }>[];
}>;

export type ResolveAnalyticalSourceResult =
  | Readonly<{
      outcome: "RESOLVED";
      source: AuthorizedAnalyticalSource;
    }>
  | Readonly<{ outcome: "NOT_FOUND" }>
  | Readonly<{
      outcome: "NOT_READY";
      status: "PROCESSING" | "FAILED";
    }>
  | Readonly<{ outcome: "UNSUPPORTED_SOURCE_TYPE" }>
  | Readonly<{ outcome: "SOURCE_UNAVAILABLE" }>
  | Readonly<{ outcome: "SOURCE_INTEGRITY_FAILED" }>
  | Readonly<{ outcome: "OPERATIONAL_FAILURE" }>;
