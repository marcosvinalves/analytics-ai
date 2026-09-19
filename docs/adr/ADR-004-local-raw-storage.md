# ADR-004 — Storage raw local e upload da Technical Alpha

Status: aceito no T-004, em 19/09/2026.

## Decisão

Usar filesystem local, isolado pela interface `RawStorage` com somente `stage`,
`publishOnce`, `discard` e `remove`. Sem factories, registries, SDKs, repositories,
filas ou jobs. PostgreSQL continua armazenando somente metadados; o futuro motor
analítico permanece independente.

O servidor gera UUIDv4 para Dataset e DatasetVersion. O namespace é `raw`; a chave é
`workspaces/{workspaceId}/versions/{datasetVersionId}/raw.csv`. O nome original é
metadado, nunca identidade ou caminho. Não armazenar credenciais, URLs assinadas ou
bytes em PostgreSQL. A migração aditiva T-004 adiciona `original_filename text`
(nulo ou não vazio) e `size_bytes bigint` (nulo ou positivo). A nulabilidade preserva
versões anteriores; novos uploads sempre preenchem ambos.

`LOCAL_STORAGE_ROOT` resolve para `.local/raw-storage` por padrão, fora de `public`
e ignorado pelo Git. O diretório deve ser privado e controlado exclusivamente pelo
operador da aplicação, sem alterações concorrentes por usuários locais não confiáveis.
O adapter recusa traversal, symlinks e junctions nos diretórios percorridos.
Estas verificações não substituem permissões do sistema operacional contra corridas
com outros processos locais.

Staging usa arquivo exclusivo em `.staging/{UUID}`. A publicação faz um hard link
atômico, que falha se o destino existe, seguido da remoção do nome temporário.
Isso exige um filesystem com hard links e staging/final no mesmo volume. Não há
fallback que sobrescreva objetos. Imutabilidade significa que o fluxo não altera
objetos publicados; não é armazenamento WORM nem proteção contra o administrador.

## Recebimento e consistência

Busboy recebe multipart em streaming com backpressure. Conta bytes efetivamente
recebidos; `Content-Length` é só uma checagem antecipada. `MAX_UPLOAD_BYTES` tem
default de 10 MiB (limite configurável da Alpha), envelope multipart limitado a
mais 64 KiB, timeout de recebimento de 60 segundos. Não há limitador de concorrência
em memória nem resposta 429. Aceita um arquivo `.csv`, MIME compatível e não vazio.
Extensão/MIME não comprovam conteúdo: parsing, encoding e validação CSV ficam futuros.

Sequência: receber/stage → validar → publicar → transação curta → inserir Dataset
e DatasetVersion → COMMIT. A consulta inicial resolve a organização pelo workspace;
a transação revalida esse vínculo e bloqueia alterações durante os inserts.
Nenhuma transação fica aberta durante a transferência.

Falha antes do COMMIT com ROLLBACK confirmado permite remover somente o objeto
criado pela operação. Falha ao conectar, antes de abrir transação, também permite
compensação. Se o COMMIT foi enviado, uma nova conexão pode confirmar a existência
do registro e retornar sucesso. Ausência do registro ou indisponibilidade não
comprovam rollback: preservar o objeto e retornar `UPLOAD_OUTCOME_UNKNOWN`.
Falhas de compensação e interrupções do processo podem deixar órfãos, inclusive
staging. Não há reconciliação automática, retry automático ou idempotency key.
Antes de remoção manual, confirmar ausência de referências e de operação em curso;
se o banco estiver indisponível ou o resultado continuar incerto, preservar os dados.
Logs contêm códigos e IDs técnicos, sem bytes, nomes, caminhos ou credenciais.

## Contexto temporário de desenvolvimento

`ENABLE_LOCAL_UPLOAD=true` funciona somente com `NODE_ENV=development`,
`DEV_UPLOAD_WORKSPACE_ID` válido definido no servidor e `LOCAL_UPLOAD_ORIGIN` HTTP
loopback. O endpoint exige Origin e Host correspondentes. Next.js pode normalizar
a URL interna para localhost; o Host da requisição identifica o destino configurado.
Iniciar o servidor em `127.0.0.1`, sem exposição pública/proxy.

**Isto NÃO é autenticação, autorização ou segurança de tenant.** Não há Membership,
User ou RLS. Organização é resolvida no PostgreSQL, não fornecida pelo cliente.
Mesmo com a flag ligada, página e endpoint ficam indisponíveis em produção.
Essas verificações servem apenas ao scaffolding local e não habilitam uso multiusuário.

## Contrato e limites do ticket

`POST /api/workspaces/{workspaceId}/datasets`: multipart com `file` obrigatório e
`name` opcional (até 200 caracteres, default nome sem `.csv`). Nome original até
255 caracteres, sem caminhos ou controles. Campos desconhecidos, duplicados e
arquivos adicionais são rejeitados. IDs, organizationId, storageKey e sourceType
nunca são aceitos como campos do cliente.

201 retorna `dataset: {id, workspaceId, name}` e
`version: {id, versionNumber, sourceType, status, originalFilename, sizeBytes}`.
A versão inicial é 1, CSV, PROCESSING. Não cria DatasetColumn, contagens, preview,
profiling ou transição READY. PROCESSING significa aguardando processamento;
nenhum processamento é disparado no T-004.

Erros: `{error: {code, message, requestId}}`; 400 multipart/nome/arquivo inválido,
403 origem, 404 contexto/workspace indisponível, 408 timeout, 413 tamanho,
415 tipo/mídia, 500 storage/erro interno, 503 banco/resultado incerto. Nenhuma
resposta expõe storage key, caminho absoluto ou erro bruto do PostgreSQL.

UI mínima em `/data/upload` mostra filename, nome, tamanho e estado aguardando
processamento. IDs ficam em detalhes. Sem polling, preview ou processamento.

## Verificação

Testes unitários cobrem validação, streaming, abort/timeout, storage exclusivo,
compensação e resultado incerto do COMMIT. Integração exige PostgreSQL real em banco
vazio dedicado: migrações/reexecução, rollback/upgrade, persistência, atomicidade e
arquivo raw. Um servidor Next dev real verifica GET da página, POST multipart,
PROCESSING/CSV e zero colunas. Isso não substitui interação manual em navegador.
