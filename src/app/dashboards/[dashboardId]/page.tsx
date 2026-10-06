import { notFound } from "next/navigation";
import {
  DashboardFailure,
  DashboardView,
} from "@/components/dashboard/dashboard-view";
import { localUploadContext } from "@/lib/local-upload-context";
import { getMetadataPool } from "@/lib/db";
import { getDashboard } from "@/modules/dashboard/infrastructure/dashboards";
import { executeDashboard } from "@/modules/dashboard/application/execute-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardPage(
  props: PageProps<"/dashboards/[dashboardId]">,
) {
  const context = localUploadContext();
  if (!context) notFound();

  const { dashboardId } = await props.params;
  const pool = getMetadataPool();
  let dashboard: Awaited<ReturnType<typeof getDashboard>>;
  try {
    dashboard = await getDashboard(pool, {
      workspaceId: context.workspaceId,
      dashboardId,
    });
  } catch {
    notFound();
  }

  if (dashboard.outcome === "NOT_FOUND") notFound();
  if (dashboard.outcome === "OPERATIONAL_FAILURE") return <DashboardFailure />;

  let execution: Awaited<ReturnType<typeof executeDashboard>>;
  try {
    execution = await executeDashboard(pool, {
      workspaceId: context.workspaceId,
      dashboardId,
    });
  } catch {
    return <DashboardFailure />;
  }

  // A posterior NOT_FOUND invalidates all visual metadata read above.
  if (execution.status === "NOT_FOUND") notFound();
  if (execution.status === "OPERATIONAL_FAILURE")
    return (
      <DashboardFailure
        inconsistent={execution.reason === "INCONSISTENT_DASHBOARD_METADATA"}
      />
    );

  return (
    <DashboardView
      name={dashboard.dashboard.name}
      description={dashboard.dashboard.description}
      execution={execution}
    />
  );
}
