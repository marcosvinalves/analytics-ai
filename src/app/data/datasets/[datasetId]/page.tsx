import { Suspense } from "react";
import { notFound } from "next/navigation";
import { localUploadContext } from "@/lib/local-upload-context";
import { getMetadataPool } from "@/lib/db";
import { readDatasetMetadata } from "@/modules/dataset/infrastructure/read-dataset-metadata";
import { readDatasetPreview } from "@/modules/dataset/infrastructure/read-dataset-preview";
import type { DatasetMetadata } from "@/modules/dataset/domain/dataset-detail";
import { DatasetDetailView } from "@/components/data/dataset-detail";
import { DatasetProcessingControl } from "@/components/data/dataset-processing-control";
import { SemanticReadinessControl } from "@/components/semantic/semantic-readiness-control";
import { PageContainer } from "@/components/layout/page-container";
import { readSemanticOnboardingReadiness } from "@/modules/semantic/infrastructure/read-semantic-onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function DatasetPage({
  params,
  searchParams,
}: {
  params: Promise<{ datasetId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const context = localUploadContext();
  if (!context) notFound();
  const { datasetId } = await params;
  const { version } = await searchParams;
  if (Array.isArray(version)) notFound();
  const pool = getMetadataPool();
  const metadata = await readDatasetMetadata(pool, {
    workspaceId: context.workspaceId,
    datasetId,
    versionId: version,
  });
  if (!metadata) notFound();
  const semanticReadiness = await readSemanticOnboardingReadiness(pool, {
    workspaceId: context.workspaceId,
    datasetId: metadata.detail.dataset.id,
    datasetVersionId: metadata.detail.version.id,
  });
  return (
    <PageContainer wide>
      <Suspense
        fallback={
          <>
            <DatasetDetailView
              detail={metadata.detail}
              processingControl={processingControl(metadata)}
              semanticControl={semanticControl(semanticReadiness)}
            />
            <p role="status">Carregando preview…</p>
          </>
        }
      >
        <PreviewDetail
          metadata={metadata}
          semanticControl={semanticControl(semanticReadiness)}
        />
      </Suspense>
    </PageContainer>
  );
}

async function PreviewDetail({
  metadata,
  semanticControl,
}: {
  metadata: DatasetMetadata;
  semanticControl?: React.ReactNode;
}) {
  const preview = await readDatasetPreview(metadata);
  return (
    <DatasetDetailView
      detail={{ ...metadata.detail, preview }}
      processingControl={processingControl(metadata)}
      semanticControl={semanticControl}
    />
  );
}

function semanticControl(
  readiness: Awaited<ReturnType<typeof readSemanticOnboardingReadiness>>,
) {
  return <SemanticReadinessControl readiness={readiness} />;
}

function processingControl(metadata: DatasetMetadata) {
  return metadata.detail.version.status === "PROCESSING" ? (
    <DatasetProcessingControl
      datasetId={metadata.detail.dataset.id}
      datasetVersionId={metadata.detail.version.id}
    />
  ) : undefined;
}
