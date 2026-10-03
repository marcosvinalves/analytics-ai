import "server-only";
import { lstat } from "node:fs/promises";
import type { Pool } from "pg";
import { storageConfig } from "../../../lib/storage/config.ts";
import { resolveLocalRaw } from "../../../lib/storage/resolve-local-raw.ts";
import {
  ProcessingDataError,
  ProcessingOperationalError,
} from "../domain/dataset-profile.ts";
import { parsePhysicalType } from "../domain/physical-type.ts";
import type {
  AnalyticalMaterialHandle,
  AuthorizedAnalyticalSource,
  ResolveAnalyticalSourceResult,
} from "../domain/analytical-source.ts";
import { validId } from "../domain/dataset-detail.ts";
import { readDatasetMetadata } from "../infrastructure/read-dataset-metadata.ts";

export type AnalyticalSourceScope = Readonly<{
  workspaceId: string;
  datasetId: string;
  datasetVersionId: string;
}>;

const localMaterialPaths = new WeakMap<object, string>();

function localMaterial(absolutePath: string): AnalyticalMaterialHandle {
  const material = Object.freeze({});
  localMaterialPaths.set(material, absolutePath);
  return material as unknown as AnalyticalMaterialHandle;
}

/** Trusted materialization boundary. The concrete path never becomes plan data. */
export function withAnalyticalMaterial<T>(
  material: AnalyticalMaterialHandle,
  work: (absolutePath: string) => T,
): T {
  const absolutePath = localMaterialPaths.get(material);
  if (!absolutePath) throw new Error("ANALYTICAL_MATERIAL_UNAVAILABLE");
  return work(absolutePath);
}

function freezeSource(
  value: Omit<AuthorizedAnalyticalSource, never>,
): AuthorizedAnalyticalSource {
  for (const column of value.schema) {
    Object.freeze(column.physicalType);
    Object.freeze(column);
  }
  Object.freeze(value.schema);
  Object.freeze(value.materialIdentity);
  return Object.freeze(value);
}

/**
 * Internal workspace-scoped resolution. The caller must already have authorized
 * the workspace; this operation is not authentication or user authorization.
 */
export async function resolveAnalyticalSource(
  pool: Pool,
  scope: AnalyticalSourceScope,
): Promise<ResolveAnalyticalSourceResult> {
  if (
    !validId(scope.workspaceId) ||
    !validId(scope.datasetId) ||
    !validId(scope.datasetVersionId)
  )
    return { outcome: "NOT_FOUND" };

  let metadata;
  try {
    metadata = await readDatasetMetadata(pool, {
      workspaceId: scope.workspaceId,
      datasetId: scope.datasetId,
      versionId: scope.datasetVersionId,
    });
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
  if (!metadata) return { outcome: "NOT_FOUND" };
  if (metadata.detail.version.status !== "READY")
    return {
      outcome: "NOT_READY",
      status: metadata.detail.version.status,
    };
  if (metadata.raw.sourceType !== "CSV")
    return { outcome: "UNSUPPORTED_SOURCE_TYPE" };

  const { columns, version } = metadata.detail;
  let expectedSizeBytes: bigint;
  let expectedRowCount: bigint;
  try {
    if (
      version.sizeBytes === null ||
      version.rowCount === null ||
      version.columnCount === null ||
      version.columnCount !== columns.length ||
      columns.length === 0
    )
      return { outcome: "SOURCE_INTEGRITY_FAILED" };
    expectedSizeBytes = BigInt(version.sizeBytes);
    expectedRowCount = BigInt(version.rowCount);
    if (expectedSizeBytes <= BigInt(0) || expectedRowCount < BigInt(0))
      return { outcome: "SOURCE_INTEGRITY_FAILED" };
  } catch {
    return { outcome: "SOURCE_INTEGRITY_FAILED" };
  }

  const names = new Set<string>();
  const schema: AuthorizedAnalyticalSource["schema"][number][] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const physicalType = parsePhysicalType(column.inferredType);
    const normalizedName = column.physicalName.toLowerCase();
    if (
      !column.physicalName.trim() ||
      column.physicalName.includes("\0") ||
      column.ordinalPosition !== index + 1 ||
      names.has(normalizedName) ||
      !physicalType
    )
      return { outcome: "SOURCE_INTEGRITY_FAILED" };
    names.add(normalizedName);
    schema.push({
      physicalName: column.physicalName,
      physicalType,
      ordinalPosition: column.ordinalPosition,
    });
  }

  let filename: string;
  let config: ReturnType<typeof storageConfig>;
  try {
    config = storageConfig();
    filename = await resolveLocalRaw(
      config.root,
      metadata.raw,
      config.maxBytes,
    );
  } catch (error) {
    if (error instanceof ProcessingDataError)
      return { outcome: "SOURCE_UNAVAILABLE" };
    if (error instanceof ProcessingOperationalError)
      return { outcome: "OPERATIONAL_FAILURE" };
    return { outcome: "OPERATIONAL_FAILURE" };
  }

  try {
    const stat = await lstat(filename, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== expectedSizeBytes
    )
      return { outcome: "SOURCE_UNAVAILABLE" };
    const material = localMaterial(filename);
    const source = freezeSource({
      datasetId: metadata.detail.dataset.id,
      datasetVersionId: version.id,
      sourceType: metadata.raw.sourceType,
      material,
      materialIdentity: {
        device: stat.dev,
        inode: stat.ino,
        sizeBytes: stat.size,
        modifiedTimeNs: stat.mtimeNs,
      },
      expectedSizeBytes,
      expectedRowCount,
      schema,
    } as unknown as AuthorizedAnalyticalSource);
    return { outcome: "RESOLVED", source };
  } catch {
    return { outcome: "OPERATIONAL_FAILURE" };
  }
}
