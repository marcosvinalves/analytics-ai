import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/page-container";
import { ActionLink } from "@/components/ui/action";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineNotice } from "@/components/ui/inline-notice";
import { PageHeader } from "@/components/ui/page-header";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { listDashboards } from "@/modules/dashboard/infrastructure/dashboards";
import styles from "./dashboard-list.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const context = localUploadContext();
  if (!context) notFound();

  const result = await listDashboards(getMetadataPool(), {
    workspaceId: context.workspaceId,
  });
  if (result.outcome === "NOT_FOUND") notFound();

  return (
    <PageContainer>
      <PageHeader
        title="Dashboards"
        description="Dashboards disponíveis neste workspace."
      />
      {result.outcome === "OPERATIONAL_FAILURE" ? (
        <InlineNotice tone="danger" role="alert">
          Não foi possível carregar os Dashboards agora.
        </InlineNotice>
      ) : result.dashboards.length === 0 ? (
        <EmptyState
          title="Nenhum dashboard disponível"
          description="Não há dashboards disponíveis neste workspace. A criação pela interface ainda não está disponível na Technical Alpha."
        />
      ) : (
        <ul className={styles.list}>
          {result.dashboards.map((dashboard) => (
            <li className={styles.card} key={dashboard.id}>
              <div>
                <h2>{dashboard.name}</h2>
                {dashboard.description && <p>{dashboard.description}</p>}
              </div>
              <ActionLink href={`/dashboards/${dashboard.id}`}>
                Abrir →
              </ActionLink>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
