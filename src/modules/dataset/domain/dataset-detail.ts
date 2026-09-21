/** Data Preview only. Not a Semantic Query or Query Engine contract. */
export type PreviewCell = { column: string; value: string | null };
export type PreviewRow = PreviewCell[];
export type Preview =
  | { state: "UNAVAILABLE" }
  | { state: "AVAILABLE"; rows: PreviewRow[]; limit: 50 }
  | { state: "ERROR"; code: "PREVIEW_READ_FAILED"; message: string };
export type DatasetDetail = {
  dataset: { id: string; name: string; description: string | null };
  version: {
    id: string;
    versionNumber: number;
    status: "PROCESSING" | "READY" | "FAILED";
    rowCount: string | null;
    columnCount: number | null;
    originalFilename: string | null;
    sizeBytes: string | null;
    processedAt: string | null;
  };
  columns: {
    physicalName: string;
    inferredType: string;
    ordinalPosition: number;
    nullable: boolean | null;
    nullCount: string | null;
  }[];
  preview: Preview;
};
export type DatasetMetadata = {
  detail: DatasetDetail;
  raw: {
    namespace: string;
    key: string;
    sizeBytes: string | null;
    sourceType: string;
  };
};
export type DatasetSelection = {
  workspaceId: string;
  datasetId: string;
  versionId?: string;
};
export const validId = (value: string) =>
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
