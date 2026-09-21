import type { DatasetDetail } from "@/modules/dataset/domain/dataset-detail";

export function DatasetDetailView({ detail }: { detail: DatasetDetail }) {
  const { dataset, version, columns, preview } = detail;
  return (
    <>
      <h1>{dataset.name}</h1>
      {dataset.description && <p>{dataset.description}</p>}
      <section aria-labelledby="overview-title">
        <h2 id="overview-title">Visão geral</h2>
        <dl className="dataset-facts">
          <div>
            <dt>Status</dt>
            <dd>{version.status}</dd>
          </div>
          <div>
            <dt>Versão</dt>
            <dd>{version.versionNumber}</dd>
          </div>
          <div>
            <dt>Linhas</dt>
            <dd>{version.rowCount ?? "Ainda não disponível"}</dd>
          </div>
          <div>
            <dt>Colunas</dt>
            <dd>{version.columnCount ?? "Ainda não disponível"}</dd>
          </div>
          <div>
            <dt>Arquivo</dt>
            <dd>{version.originalFilename ?? "Não informado"}</dd>
          </div>
          <div>
            <dt>Tamanho</dt>
            <dd>
              {version.sizeBytes === null
                ? "Não informado"
                : `${version.sizeBytes} bytes`}
            </dd>
          </div>
          <div>
            <dt>Processado em (UTC)</dt>
            <dd>{version.processedAt ?? "Ainda não processado"}</dd>
          </div>
        </dl>
      </section>
      {version.status === "PROCESSING" && (
        <p role="status">
          Aguardando conclusão do processamento. Atualize a página após o
          processamento local explícito.
        </p>
      )}
      {version.status === "FAILED" && (
        <p role="alert">
          Não foi possível processar esta versão. O preview não está disponível.
        </p>
      )}
      {version.status === "READY" && (
        <>
          <section aria-labelledby="schema-title">
            <h2 id="schema-title">Schema</h2>
            <p>
              Tipos físicos detectados. “Desconhecido” não significa uma
              restrição NOT NULL.
            </p>
            <div
              className="data-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Schema do dataset"
            >
              <table>
                <thead>
                  <tr>
                    <th>Posição</th>
                    <th>Coluna</th>
                    <th>Tipo</th>
                    <th>Aceita NULL</th>
                    <th>Contagem NULL</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.physicalName}>
                      <td>{c.ordinalPosition}</td>
                      <th scope="row">{c.physicalName}</th>
                      <td>{c.inferredType}</td>
                      <td>
                        {c.nullable === null
                          ? "Desconhecido"
                          : c.nullable
                            ? "Sim"
                            : "Não"}
                      </td>
                      <td>{c.nullCount ?? "Desconhecida"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section aria-labelledby="preview-title">
            <h2 id="preview-title">Preview</h2>
            <p>
              Até 50 linhas, somente leitura. Sem filtros ou ordenação
              analítica. Valores exibidos como texto; DOUBLE permanece
              aproximado.
            </p>
            {preview.state === "ERROR" && <p role="alert">{preview.message}</p>}
            {preview.state === "AVAILABLE" &&
              (preview.rows.length === 0 ? (
                <p>Este arquivo não contém linhas de dados.</p>
              ) : (
                <>
                  <p>{preview.rows.length} linhas exibidas.</p>
                  <div
                    className="data-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Linhas do preview"
                  >
                    <table>
                      <thead>
                        <tr>
                          {columns.map((c) => (
                            <th key={c.physicalName} scope="col">
                              {c.physicalName}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell) => (
                              <td key={cell.column}>
                                {cell.value === null ? (
                                  <span className="null-value">NULL</span>
                                ) : cell.value === "" ? (
                                  <span aria-label="Texto vazio">“”</span>
                                ) : (
                                  cell.value
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ))}
          </section>
        </>
      )}
    </>
  );
}
