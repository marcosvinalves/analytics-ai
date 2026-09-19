import { notFound } from "next/navigation";
import { UploadForm } from "@/components/data/upload-form";
import { localUploadContext } from "@/lib/local-upload-context";
import { storageConfig } from "@/lib/storage/config";

export const dynamic = "force-dynamic";

export default function UploadPage() {
  const context = localUploadContext();
  if (!context) notFound();
  return (
    <main>
      <h1>Enviar CSV</h1>
      <p>Technical Alpha — ferramenta local de desenvolvimento.</p>
      <UploadForm
        workspaceId={context.workspaceId}
        maxBytes={storageConfig().maxBytes}
      />
    </main>
  );
}
