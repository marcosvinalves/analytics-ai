import "server-only";
import type { Pool } from "pg";
import type {
  DatasetDetail,
  DatasetSelection,
} from "../domain/dataset-detail.ts";
import { readDatasetMetadata } from "../infrastructure/read-dataset-metadata.ts";
import { readDatasetPreview } from "../infrastructure/read-dataset-preview.ts";

export async function getDatasetDetail(
  pool: Pool,
  scope: DatasetSelection,
): Promise<DatasetDetail | null> {
  const metadata = await readDatasetMetadata(pool, scope);
  if (!metadata) return null;
  return { ...metadata.detail, preview: await readDatasetPreview(metadata) };
}
