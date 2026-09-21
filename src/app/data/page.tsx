import Link from "next/link";
import { notFound } from "next/navigation";
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
    <main>
      <nav aria-label="Navegação">
        <Link href="/">Início</Link> ·{" "}
        <Link href="/data/upload">Enviar CSV</Link>
      </nav>
      <h1>Dados</h1>
      <p>
        Technical Alpha — acesso local de desenvolvimento. Não constitui
        autenticação ou segurança de tenant.
      </p>
      <p>Até 50 datasets mais recentes deste workspace.</p>
      {datasets.length === 0 ? (
        <p>
          Nenhum dataset disponível.{" "}
          <Link href="/data/upload">Envie um CSV</Link> para começar.
        </p>
      ) : (
        <ul className="dataset-list">
          {datasets.map((d) => (
            <li key={d.id}>
              <Link prefetch={false} href={`/data/datasets/${d.id}`}>
                {d.name}
              </Link>
              <span>
                {d.status ?? "Sem versão"}
                {d.versionNumber !== null && ` · Versão ${d.versionNumber}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
