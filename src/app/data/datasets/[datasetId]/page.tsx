import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { localUploadContext } from "@/lib/local-upload-context";
import { getMetadataPool } from "@/lib/db";
import { readDatasetMetadata } from "@/modules/dataset/infrastructure/read-dataset-metadata";
import { readDatasetPreview } from "@/modules/dataset/infrastructure/read-dataset-preview";
import type { DatasetMetadata } from "@/modules/dataset/domain/dataset-detail";
import { DatasetDetailView } from "@/components/data/dataset-detail";

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
  const metadata = await readDatasetMetadata(getMetadataPool(), {
    workspaceId: context.workspaceId,
    datasetId,
    versionId: version,
  });
  if (!metadata) notFound();
  return (
    <main className="dataset-detail">
      <nav aria-label="Navegação">
        <Link href="/data">Dados</Link> ·{" "}
        <Link href="/data/upload">Enviar CSV</Link>
      </nav>
      <p>Technical Alpha — inspeção local, somente leitura.</p>
      <Suspense
        fallback={
          <>
            <DatasetDetailView detail={metadata.detail} />
            <p role="status">Carregando preview…</p>
          </>
        }
      >
        <PreviewDetail metadata={metadata} />
      </Suspense>
    </main>
  );
}

async function PreviewDetail({ metadata }: { metadata: DatasetMetadata }) {
  const preview = await readDatasetPreview(metadata);
  return <DatasetDetailView detail={{ ...metadata.detail, preview }} />;
}
