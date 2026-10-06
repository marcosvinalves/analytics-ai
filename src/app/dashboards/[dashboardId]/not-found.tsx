import { PageHeader } from "@/components/ui/page-header";
import { ActionLink } from "@/components/ui/action";
import { EmptyState } from "@/components/ui/empty-state";

export default function DashboardNotFound() {
  return (
    <>
      <PageHeader
        title="Dashboard não encontrado"
        breadcrumbs={[{ label: "Início", href: "/" }, { label: "Dashboard" }]}
      />
      <EmptyState
        title="Dashboard indisponível"
        description="O Dashboard solicitado não está disponível."
        action={<ActionLink href="/">Voltar ao início</ActionLink>}
      />
    </>
  );
}
