import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { ActionLink } from "@/components/ui/action";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import styles from "@/components/data/data.module.css";
import { localUploadContext } from "@/lib/local-upload-context";
import { getMetadataPool } from "@/lib/db";
import { listDatasets } from "@/modules/dataset/infrastructure/read-dataset-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DataPage() {
  const context = localUploadContext();
  if (!context) notFound();
  const datasets = await listDatasets(getMetadataPool(), context.workspaceId);
  return (
    <PageContainer>
      <PageHeader
        title="Dados"
        description="Datasets disponíveis neste workspace."
        actions={
          <ActionLink href="/data/upload" variant="primary">
            Enviar CSV
          </ActionLink>
        }
      />
      {datasets.length === 0 ? (
        <EmptyState
          title="Nenhum dataset disponível"
          description="Envie um CSV para começar."
          action={<ActionLink href="/data/upload">Enviar CSV</ActionLink>}
        />
      ) : (
        <ul className={styles.datasetList}>
          {datasets.map((dataset) => (
            <li className={styles.datasetRow} key={dataset.id}>
              <Link
                className={styles.datasetName}
                prefetch={false}
                href={`/data/datasets/${dataset.id}`}
              >
                {dataset.name}
              </Link>
              <span className={styles.datasetMeta}>
                <StatusBadge status={dataset.status ?? "NO_VERSION"} />
                {dataset.versionNumber !== null && (
                  <span>Versão {dataset.versionNumber}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
