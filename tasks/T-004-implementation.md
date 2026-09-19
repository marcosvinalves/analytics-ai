# T-004 — Relatório de implementação

Implementado em 19/09/2026, aguardando revisão. T-005 não iniciado.

## Resultado

Upload CSV local em `/data/upload` e
`POST /api/workspaces/{workspaceId}/datasets`. Contrato, configuração, layout e
consistência detalhados no [README](../README.md) e no
[ADR-004](../docs/adr/ADR-004-local-raw-storage.md).

Multipart aceita somente `file` e `name` opcional. Retorna 201 com dataset
(id/workspaceId/name) e version (id/versionNumber/sourceType/status/originalFilename/sizeBytes).
Versão 1, CSV, PROCESSING; nenhuma coluna ou processamento criado. Erros usam
`{error: {code, message, requestId}}`. Contexto local não é autenticação, autorização
ou segurança de tenant; bloqueado em produção.

Storage raw: `.local/raw-storage/workspaces/{workspaceId}/versions/{datasetVersionId}/raw.csv`;
temporários em `.staging/{UUID}`. Identificadores e chaves vêm do servidor.
Interface restrita a stage/publishOnce/discard/remove. Transação somente após a
publicação; compensação em rollback confirmado e preservação em COMMIT incerto.

## Dependências e migração

- `busboy@1.6.0`: parsing multipart em streaming e limites durante recebimento.
- `@types/busboy@1.5.4`: tipagem TypeScript do parser, somente desenvolvimento.
- Nenhuma outra dependência adicionada. Instalação reportou zero vulnerabilidades.
- `202609190003_add_upload_metadata.sql`: original_filename text nullable com CHECK
  não vazio; size_bytes bigint nullable com CHECK positivo. Compatibilidade com
  registros anteriores; uploads novos preenchem ambos. Sem tabelas ou índices novos.
- Migrações anteriores preservadas. Três migrações aplicadas em banco vazio;
  reexecução sem reaplicação; rollback/upgrade explícitos verificados pela suíte.

## Comandos e resultados

Node 22.23.2 e npm 11.12.1 selecionados via
`npx --yes --package=node@22.23.2 --package=npm@11.12.1 --call "<comando>"`.

| Comando/check | Resultado final |
| --- | --- |
| npm install --save-exact busboy@1.6.0 | instalado |
| npm install --save-dev --save-exact @types/busboy@1.5.4 | instalado |
| npm run format | passou |
| npm run check (typecheck, lint, format:check, npm test) | passou |
| npm test | 56 testes unitários, 9 arquivos, passaram |
| npm run test:integration | 63 testes, 4 arquivos, passaram com PostgreSQL real |
| npm run build | passou, sem aviso no build final |
| Next start + fetch HTTP | GET / = 200; GET /data/upload = 404; POST upload = 404 em produção, mesmo com flag ligada |
| git diff --check | passou; avisos Git de conversão LF/CRLF |

PostgreSQL 18.6 nativo: initdb/pg_ctl/createdb em cluster temporário isolado, loopback,
senha aleatória em ambiente. Duas execuções da suíte usaram databases vazios distintos.
A primeira encontrou 2 falhas HTTP por normalização da URL interna no Next.js;
validação corrigida para Origin/Host e coberta por teste. Segunda execução: 63/63.
O primeiro build avisou sobre rastreamento do storage dinâmico; configuração foi
ajustada para excluir dados de runtime do tracing e o build final não apresentou o aviso.

Integração verifica conectividade, migrações, constraints, atomicidade dos inserts,
compensação, bytes preservados no disco e upload por servidor Next dev real.
Unitários cobrem tamanho real sem confiar em Content-Length, limites, timeout,
multipart inválido, nome/caminhos, publicação exclusiva e resultados incertos do COMMIT.
Incerteza de COMMIT é testada com falhas controladas no cliente; não foi simulada uma
interrupção física de rede durante COMMIT em PostgreSQL real.

## Verificação da Web App

Navegador interativo indisponível nesta sessão: seleção manual de arquivo, clique e
renderização do estado de sucesso no browser não foram verificados manualmente.
O teste HTTP abre `/data/upload`, confere formulário, envia CSV multipart real e
confirma resposta de sucesso, arquivo raw idêntico, Dataset, DatasetVersion,
PROCESSING, CSV e zero DatasetColumn. Isso não substitui teste visual/hidratação.
O README contém roteiro para revisão manual.

## Arquivos criados

- docs/adr/ADR-004-local-raw-storage.md
- migrations/202609190003_add_upload_metadata.sql
- src/app/api/workspaces/[workspaceId]/datasets/route.ts
- src/app/data/upload/page.tsx
- src/components/data/upload-form.tsx
- src/lib/local-upload-context.ts
- src/lib/storage/config.ts
- src/lib/storage/key.ts
- src/lib/storage/local-raw-storage.ts
- src/lib/storage/raw-storage.ts
- src/modules/dataset/application/upload-dataset.ts
- src/modules/dataset/application/upload-errors.ts
- src/modules/dataset/domain/upload-validation.ts
- src/modules/dataset/infrastructure/insert-upload-metadata.ts
- src/modules/dataset/infrastructure/receive-multipart.ts
- tests/helpers/uploads.ts
- tests/integration/csv-upload.test.ts
- tests/integration/upload-route.test.ts
- tests/unit/insert-upload-metadata.test.ts
- tests/unit/local-raw-storage.test.ts
- tests/unit/local-upload-context.test.ts
- tests/unit/receive-multipart.test.ts
- tests/unit/storage-config.test.ts
- tests/unit/upload-dataset.test.ts
- tests/unit/upload-validation.test.ts
- tasks/T-004-implementation.md

## Arquivos modificados

- .env.example, .gitignore
- package.json, package-lock.json
- src/app/page.tsx
- tests/integration/setup.ts, tests/integration/db-foundation.test.ts
- README.md, docs/TDD.md
- docs/adr/ADR-009-database-migrations.md, docs/adr/ADR-010-core-metadata-schema.md
- tasks/EPIC-01-data-foundation.md
- AGENTS.md: bloco de orientação acrescentado automaticamente pelo Next dev e preservado.

next-env.d.ts foi regenerado durante os checks e voltou ao conteúdo original após build.

## Limitações e riscos

Sem desvio funcional do escopo aprovado. Sem limite concorrente por processo,
parsing, profiling, inferência, READY, DuckDB, autenticação, RLS ou features futuras.
O limite de 10 MiB é configurável para Alpha, não permanente.

Filesystem exige hard links no mesmo volume e diretório privado; não protege contra
administrador ou processos com permissão de escrita. Queda do processo, COMMIT incerto
ou falha de compensação podem deixar órfãos. Não há reconciliação/retry automático.
Extensão/MIME não garantem conteúdo CSV válido; validação estrutural pertence à etapa futura.
Permanece o aviso preexistente de suporte do ESLint 9 descrito no README.

O cluster temporário foi encerrado, seu arquivo de senha removido e os serviços PostgreSQL
preexistentes preservados. Dados do cluster parado permanecem em
`%TEMP%/analytics-t004-fab9337ebed34649bd8521cc9dde8a71` para inspeção/limpeza posterior.
Nenhuma migração foi aplicada aos bancos de desenvolvimento preexistentes.
