"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";

type UploadResult = {
  dataset: { id: string; name: string };
  version: {
    id: string;
    versionNumber: number;
    originalFilename: string;
    sizeBytes: number;
    status: string;
  };
};

export function UploadForm({
  workspaceId,
  maxBytes,
}: {
  workspaceId: string;
  maxBytes: number;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");
  // SSR must stay inert until React attaches onSubmit, including when JS fails.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const disabled = !hydrated || pending;
  const endpoint = `/api/workspaces/${workspaceId}/datasets`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    setResult(null);
    setError("");
    if (!(file instanceof File) || file.size === 0) {
      setError("Selecione um arquivo CSV não vazio.");
      return;
    }
    if (file.size > maxBytes) {
      setError("O arquivo excede o limite permitido.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: data,
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error?.message || "Não foi possível concluir o upload.");
        return;
      }
      setResult(body);
      form.reset();
    } catch {
      setError(
        "Não foi possível confirmar o envio. Não repita automaticamente; verifique o resultado local.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p>
        Selecione um CSV de até {(maxBytes / 1048576).toLocaleString("pt-BR")}{" "}
        MiB.
      </p>
      <form
        onSubmit={submit}
        action={endpoint}
        method="post"
        encType="multipart/form-data"
      >
        <p>
          <label htmlFor="dataset-name">Nome do dataset (opcional)</label>
          <br />
          <input
            id="dataset-name"
            name="name"
            maxLength={200}
            disabled={disabled}
          />
        </p>
        <p>
          <label htmlFor="csv-file">Arquivo CSV</label>
          <br />
          <input
            id="csv-file"
            name="file"
            type="file"
            accept=".csv"
            required
            disabled={disabled}
          />
        </p>
        <button type="submit" disabled={disabled}>
          {!hydrated
            ? "Preparando formulário…"
            : pending
              ? "Enviando…"
              : "Enviar CSV"}
        </button>
      </form>
      <noscript>
        Ative o JavaScript para enviar o CSV sem sair desta página.
      </noscript>
      {error && <p role="alert">{error}</p>}
      {result && (
        <section role="status" aria-label="Upload concluído">
          <h2>Arquivo recebido e armazenado</h2>
          <p>Dataset: {result.dataset.name}</p>
          <p>Arquivo: {result.version.originalFilename}</p>
          <p>Número da versão: {result.version.versionNumber}</p>
          <p>
            Tamanho: {result.version.sizeBytes.toLocaleString("pt-BR")} bytes
          </p>
          <p>PROCESSING — aguardando processamento local explícito.</p>
          <p>
            <Link
              prefetch={false}
              href={`/data/datasets/${result.dataset.id}?version=${result.version.id}`}
            >
              Abrir dataset
            </Link>
          </p>
          <details>
            <summary>Identificadores para desenvolvimento</summary>
            <p>Dataset: {result.dataset.id}</p>
            <p>Versão: {result.version.id}</p>
          </details>
        </section>
      )}
    </>
  );
}
