import { notFound } from "next/navigation";
import { UploadForm } from "@/components/data/upload-form";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { localUploadContext } from "@/lib/local-upload-context";
import { storageConfig } from "@/lib/storage/config";

export const dynamic = "force-dynamic";

export default function UploadPage() {
  const context = localUploadContext();
  if (!context) notFound();
  return (
    <PageContainer>
      <PageHeader
        title="Enviar CSV"
        description="Adicione um arquivo bruto ao pipeline de dados local."
        breadcrumbs={[
          { label: "Dados", href: "/data" },
          { label: "Enviar CSV" },
        ]}
      />
      <UploadForm
        workspaceId={context.workspaceId}
        maxBytes={storageConfig().maxBytes}
      />
    </PageContainer>
  );
}
