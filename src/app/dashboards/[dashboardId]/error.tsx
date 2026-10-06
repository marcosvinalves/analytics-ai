"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/action";
import { InlineNotice } from "@/components/ui/inline-notice";

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <>
      <PageHeader
        title="Dashboard temporariamente indisponível"
        breadcrumbs={[{ label: "Início", href: "/" }, { label: "Dashboard" }]}
      />
      <InlineNotice tone="danger" role="alert">
        <p>Não foi possível carregar o Dashboard agora.</p>
        <p>
          <Button type="button" onClick={reset}>
            Tentar novamente
          </Button>
        </p>
      </InlineNotice>
    </>
  );
}
