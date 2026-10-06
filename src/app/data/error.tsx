"use client";

import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { ActionLink } from "@/components/ui/action";
import { InlineNotice } from "@/components/ui/inline-notice";

export default function DataError() {
  return (
    <PageContainer>
      <PageHeader title="Dados indisponíveis" />
      <InlineNotice tone="danger" role="alert">
        <p>
          Não foi possível carregar os dados agora. Tente novamente mais tarde.
        </p>
        <p>
          <ActionLink href="/data">Voltar para Dados</ActionLink>
        </p>
      </InlineNotice>
    </PageContainer>
  );
}
