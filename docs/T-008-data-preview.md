# T-008 — Data Preview: implementação e verificação

Status: implementado para revisão. T-009 não iniciado.
Ambiente: Windows x64, Node 22.23.2, Next.js 16.3.5, @duckdb/node-api 1.5.5-r.5,
PostgreSQL 18.6 para integração isolada. Nenhuma migration ou dependência nova.

## Rotas e comportamento

- `/data`: até 50 datasets recentes do workspace resolvido no servidor; estado vazio com link de upload.
- `/data/datasets/[datasetId]`: maior version_number, sem preferência implícita por READY.
- `?version=<uuid>`: versão específica, validada dentro do mesmo dataset/workspace.
- PROCESSING: aguardando processamento, sem abrir raw/DuckDB.
- FAILED: mensagem segura, sem preview ou exposição do erro interno.
- READY: visão geral, schema persistido e preview. Zero linhas produz estado vazio.
- IDs inválidos/inexistentes, escopo incorreto e contexto desabilitado: HTTP 404.
- Erro de infraestrutura dos metadados: tela segura de indisponibilidade.
- Erro de leitura/integridade: schema/metadados continuam visíveis; versão permanece READY.

Não há endpoint novo. Server Components chamam funções server-only em runtime Node.
O contexto T-004 continua exclusivamente local, não é autenticação/autorização/segurança de tenant.
Nenhum caminho, SQL, storage key ou workspace de autorização é recebido do cliente.
As rotas são dinâmicas, sem cache compartilhado; links de detalhe não fazem prefetch.

## Contrato

`DatasetDetail` contém dataset (id/nome/descrição), versão (id/número/status/contagens/arquivo/
tamanho/processedAt), colunas ordenadas (nome/tipo/posição/nullable/nullCount) e preview:

```ts
type PreviewCell = { column: string; value: string | null };
type PreviewRow = PreviewCell[];
type Preview =
  | { state: "UNAVAILABLE" }
  | { state: "AVAILABLE"; rows: PreviewRow[]; limit: 50 }
  | { state: "ERROR"; code: "PREVIEW_READ_FAILED"; message: string };
```

Contagens bigint/tamanho usam string decimal. processedAt usa ISO UTC. O raw reference é
interno e não integra o DTO entregue à UI. Este contrato não é um Query Engine genérico.

## Leitura, integridade e serialização

Metadados são lidos com snapshot PostgreSQL REPEATABLE READ READ ONLY e ordenação explícita.
A transação termina antes de abrir o arquivo. RawStorage permanece inalterado.

O leitor valida namespace/key, contenção, symlinks/junctions, arquivo regular, tamanho e UTF-8.
Reutiliza o dialeto CSV T-007. `auto_detect=false` e tipos/nomes persistidos evitam reinferência.
Uma leitura do cabeçalho como VARCHAR verifica os nomes, incluindo espaços, vazios e duplicatas
normalizados pelo binding de nomes do DuckDB. Colunas são projetadas explicitamente, com escaping,
tipos permitidos e caminho parametrizado. LIMIT 50 é fixo, não controlado pelo cliente.

Valores são convertidos para VARCHAR dentro do DuckDB. BIGINT/DECIMAL não passam por Number;
DATE/TIMESTAMP não passam por Date JS. TIMESTAMP mantém ausência de timezone; TIMESTAMPTZ usa UTC.
DOUBLE mantém sua natureza aproximada, inclusive `nan`/`inf` textuais. NULL é null; texto vazio
tem indicação própria na UI. React escapa conteúdo de nomes/células. Tipos fora da lista aceita
retornam erro seguro, sem tentativa de inferência/correção.

Incompatibilidade observada em cabeçalho, estrutura ou conversão retorna PREVIEW_READ_FAILED.
Não chama lifecycle, não altera DatasetColumn, não marca FAILED e não tenta reparar dados.
Conexão/instância DuckDB sempre são fechadas. Fingerprints antes/depois detectam mudanças durante
a leitura; não comprovam identidade histórica sem checksum persistido.

## Next.js e evidência prática

1. Build real inicial falhou: Turbopack tentou resolver bindings nativos não instalados de outros SOs.
2. Foi explicado e adicionado `serverExternalPackages: ["@duckdb/node-api"]`.
3. Build real passou. O artefato real iniciado por next start retornou HTTP 404 nas rotas dev-only.
4. Como o bloqueio impede a consulta de produto em produção, um harness mínimo gera somente
   route.js/config em `.local`, importa a MESMA função readDatasetPreview e a configuração real,
   compila/inicia Next, executa SQL pelo binding nativo e verifica valores exatos. Não copia a app,
   não reimplementa leitura, não usa PostgreSQL e não deixa rota de teste no produto.
5. O teste comprovou carregamento nativo E execução real da consulta no Next compilado local.

O loading usa Suspense depois da validação do recurso. `loading.tsx` no segmento antecipava
streaming, fazendo notFound responder 200; foi removido em favor dessa posição explícita.
Sem JavaScript, metadados/schema continuam legíveis, mas a substituição do preview streaming
depende de JavaScript. O navegador normal não apresentou erros de hidratação.

## Dataset real e ausência de alterações

Dataset `43bc5816-4c71-4e1c-a9f9-c7afaea212cd`, versão `a7eaab8d-9ad2-44c5-a742-d7b02a87c72c`:
READY, 20 linhas, 7 colunas. A interface exibiu todas as vendas.

| Coluna | Tipo persistido |
| --- | --- |
| data_venda | DATE |
| produto | VARCHAR |
| categoria | VARCHAR |
| cidade | VARCHAR |
| quantidade | BIGINT |
| preco_unitario | DOUBLE |
| receita | DOUBLE |

Antes/depois do E2E, snapshots completos das cinco tabelas de domínio permaneceram idênticos,
incluindo status, colunas e timestamps. O teste não chama o processamento nem cria dados reais.
SHA-256 do raw permaneceu:
`5588ec80a695b1be608aa0a7783b82c5aa9cd54a0e9fb4a338ea027242843796`.
Fixtures e migrations de testes foram executadas apenas em bancos temporários separados.

## Verificações

- `npm run format`, `typecheck`, `lint`, `format:check`: passaram.
- `npm test`: 104 testes passaram.
- `npm run test:integration`: 104 testes passaram em banco limpo separado.
- `npm run test:preview-ui`: 3 passaram no dataset real, com snapshots/hash antes/depois.
- `npm run test:upload-ui`: 3 passaram, preservando a regressão anterior do formulário.
- `npm run build`: passou após externalização justificada.
- `npm run test:preview-runtime`: artefato real bloqueado; harness compilado executou consulta real.

Casos verificados: seleção de versão, escopo, 404, colunas ordenadas, limite 50, vazio,
PROCESSING/FAILED sem raw, raw ausente, traversal/junction, cabeçalho/tipo/largura incompatíveis,
UTF-8, NULL, BIGINT 9007199254740993, DECIMAL 1234567890123456.78, DOUBLE 0.1,
DATE, TIMESTAMP com microssegundos, TIMESTAMPTZ UTC, NaN/Infinity e escaping de HTML.

## Arquivos T-008

Criados:
- src/app/data/page.tsx, src/app/data/error.tsx, src/app/data/datasets/[datasetId]/page.tsx
- src/components/data/dataset-detail.tsx
- src/modules/dataset/domain/dataset-detail.ts
- src/modules/dataset/application/get-dataset-detail.ts
- src/modules/dataset/infrastructure/read-dataset-metadata.ts, read-dataset-preview.ts, csv-options.ts
- scripts/tests/preview-runtime.mjs
- tests/unit/dataset-detail.test.ts, tests/integration/dataset-preview.test.ts,
  tests/e2e/dataset-detail.spec.ts
- docs/T-008-data-preview.md

Alterados:
- src/app/page.tsx, src/app/globals.css, src/components/data/upload-form.tsx
- src/modules/dataset/infrastructure/inspect-csv.ts (opções compartilhadas/fingerprint reutilizável)
- next.config.ts, eslint.config.mjs, package.json
- README.md, docs/TDD.md, tasks/EPIC-01-data-foundation.md

As alterações T-007 já existentes e não commitadas foram preservadas; não são novas dependências
ou migrations do T-008. Fixtures de preview são criadas pelos testes, sem infraestrutura de fixtures nova.

## Limitações e desvios

- Nenhum desvio de escopo funcional. Loading implementado com Suspense após o escopo para preservar 404.
- Limite de 50 controla retorno, não garante leitura física de apenas 50 linhas. O arquivo tem o limite
  Alpha configurado; fingerprints percorrem o arquivo e o parser pode ler blocos maiores.
- Não há validação integral de todos os valores fora do prefixo retornado, checksum histórico,
  ordenação analítica ou promessa de paginação estável. Administrador/OS ainda pode alterar raw.
- Formatos de data dependentes da inferência original que não são representáveis pelo leitor explícito
  podem gerar erro seguro; não há reinferência silenciosa para contornar isso.
- Memória DuckDB (256 MB) e duas threads não equivalem a isolamento de processo/RSS ou timeout global.
  Concorrência/carga/cancelamento no servidor web não foram certificados.
- Linux, ARM, containers, standalone tracing, serverless e deploy alvo não foram testados.
  Externalização exige distribuir o pacote e o binário correto; filesystem persistente também é necessário.
- Nenhuma migration, pacote novo, autenticação, RLS, Query Engine genérico ou T-009.
