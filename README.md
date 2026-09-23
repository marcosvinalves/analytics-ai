# Analytics AI

Technical Alpha (T-001 a T-004): Next.js App Router, React, TypeScript, PostgreSQL para metadados e upload CSV local.
O upload persiste o arquivo raw e cria Dataset/DatasetVersion em PROCESSING, aguardando processamento futuro.

## Requisitos

- Node.js **22.23.2 LTS**, registrado em `.nvmrc`.
- npm **11.12.1**, usado na instalação e validação.

A linha Node 22 está em Maintenance LTS, com suporte até 30/04/2027.
Ela satisfaz o mínimo do Next.js 16 (`>=20.9`) e do Vitest 5 (`^22.12`).
A escolha independe do Node instalado globalmente na máquina.
TypeScript 5.9.3 mantém a configuração na linha 5, compatível com o tooling selecionado.

Referências: [ciclo de suporte do Node](https://github.com/nodejs/Release),
[instalação do Next.js](https://nextjs.org/docs/app/getting-started/installation).
As versões exatas estão em `package.json` e `package-lock.json`.

Aviso de tooling: ESLint 9.39.5 está fora de suporte, mas o plugin React usado
por `eslint-config-next` ainda declara suporte somente até ESLint 9.
Reavaliar a atualização quando essa cadeia suportar ESLint 10.

## Executar localmente

Ative a versão de `.nvmrc` com seu gerenciador de Node. No nvm-windows:

```powershell
nvm install 22.23.2
nvm use 22.23.2
npm ci
npm run dev
```

Abra <http://localhost:3000>. A página estática e o build não exigem banco.
Operações de metadados exigem `DATABASE_URL`. `.env.local` é ignorado pelo Git.
Nunca coloque segredos em variáveis `NEXT_PUBLIC_`.

## PostgreSQL e migrações (T-002)

PostgreSQL guarda metadados da aplicação. O futuro motor de consultas analíticas tem arquitetura
independente e continua pendente do SP-01. T-002 cria a fundação; T-003 adiciona somente o schema de metadados.

Copie `.env.example` para `.env.local` e preencha `DATABASE_URL` com a URL completa do database.
Use `postgresql://<usuario>:<senha-escapada>@<host>:<porta>/<database>`; escape os componentes
de usuário/senha com percent-encoding. Não faça referência a outras variáveis dentro da URL.
Variáveis exportadas no processo têm precedência sobre o arquivo local.
Os scripts carregam somente `.env.local`, não toda a hierarquia `.env*` do Next.js.

O database deve existir antes das migrações. Os comandos não criam databases ou usuários.

### Opção A: Docker Compose

Instale/inicie Docker com Compose e preencha também `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` e `POSTGRES_PORT` no arquivo local. A URL deve usar os mesmos valores,
host `127.0.0.1` e a porta publicada. Não há senha padrão.

```powershell
Copy-Item .env.example .env.local
# Preencha o arquivo local antes de iniciar o banco.
docker compose --env-file .env.local up -d --wait
npm run db:check
npm run db:migrate
```

Compose usa `postgres:18.6-bookworm`, healthcheck e volume nomeado persistente.
A porta fica restrita a `127.0.0.1`; a aplicação roda normalmente no host.
Se 5432 já estiver ocupada, escolha outra `POSTGRES_PORT` e ajuste a URL.
Para parar preservando os dados: `docker compose --env-file .env.local down`.
As variáveis de inicialização da imagem só criam usuário/database em volume vazio;
alterar a senha no arquivo não altera a senha de um cluster já inicializado.
Não use o usuário administrador local deste exemplo como modelo de permissões de produção.

### Opção B: PostgreSQL nativo ou existente

Provisione um database vazio dedicado e um usuário com permissão para conectar e criar schemas.
Por exemplo, com as ferramentas PostgreSQL e um usuário previamente provisionado:

```powershell
createdb -h 127.0.0.1 -p 5432 -U <usuario> -W -O <usuario> analytics_metadata
```

A senha é solicitada interativamente. Configure `DATABASE_URL`, execute `npm run db:check`
e `npm run db:migrate`. Não são necessárias variáveis `POSTGRES_*` ou Docker nesse caminho.
No Windows, se as ferramentas não estiverem no PATH, use o diretório `bin` da instalação.
Em servidores remotos, configure TLS conforme o provedor, sem desativar validação do certificado.

### Resultado e manutenção

```text
database de metadados
├── app
│   ├── organizations
│   ├── workspaces
│   ├── datasets
│   ├── dataset_versions
│   └── dataset_columns
└── migration_metadata
    └── history                 (controle técnico de migrações)
```

`npm run db:migrate` aplica SQL de `migrations/` com transação, ordem e advisory lock.
Uma segunda execução deve informar zero migrações aplicadas. Não altera o build ou o startup.
Migrações novas recebem prefixo numérico crescente; não modifique as já aplicadas.
Em um banco vazio são aplicadas três migrações; em um banco T-003, somente a migração aditiva T-004.
Não há reset automático ou seeds. O upload local cria Dataset e DatasetVersion.
O schema `public` padrão do PostgreSQL permanece sem tabelas da aplicação.

O [ADR-010](docs/adr/ADR-010-core-metadata-schema.md) documenta as colunas, constraints e índices.
IDs usam UUIDv4 gerado no banco; timestamps usam `timestamptz`.
As quatro FKs usam `ON DELETE RESTRICT ON UPDATE RESTRICT`.
O trigger `updated_at` mantém apenas timestamps: não implementa versionamento, autorização ou imutabilidade.
`source_type` aceita texto não vazio; tipos suportados serão validados pela aplicação.
As referências de storage nunca devem conter bytes de arquivos, credenciais ou URLs assinadas.

Os módulos de metadados ficam em `src/lib/db`; a aplicação server-side importa `@/lib/db`.
O pool nativo de `pg` é criado sob demanda. Scripts usam TypeScript nativo do Node e
`--env-file-if-exists`; não foi necessário instalar `tsx` ou `@next/env`.
`server-only` impede o uso do pool em componentes cliente.

### Integração com banco limpo

Crie um database vazio separado, terminado em `_test`, configure `TEST_DATABASE_URL` e execute:

```sh
npm run test:integration
```

A suíte verifica conectividade, migração completa, reaplicação sem mudanças no histórico,
rollback explícito de T-004/T-003 e upgrade da fundação T-002, além das constraints das cinco tabelas.
Também testa upload com filesystem/PostgreSQL e inicia Next dev em porta loopback temporária
para verificar a página e o endpoint HTTP real. Encerre outras instâncias de Next dev do checkout
antes da suíte (o diretório de build de desenvolvimento é compartilhado).
Ela não usa fallback para `DATABASE_URL`.
Se não houver configuração/conectividade, o comando falha explicitamente.
A preparação global recusa schemas `app`/`migration_metadata` e tabelas preexistentes.
O teste de rollback remove/recria somente as tabelas que essa execução criou no banco descartável.
Os testes de schema usam transações com rollback; os de upload removem somente seus próprios fixtures.
Após a execução, mantenha o banco para inspeção ou recrie apenas esse database descartável
antes de repetir a suíte. O banco de desenvolvimento nunca é resetado pelos testes.

## Upload CSV local (T-004)

O contexto temporário **não é autenticação, autorização ou segurança de tenant**.
Não use em ambiente público, multiusuário ou produção. Página e endpoint retornam 404
em produção mesmo com a flag ligada. Organização vem do banco; workspace é configuração do servidor.

Depois de aplicar as migrações, use um workspace local existente ou crie explicitamente
um fixture no seu banco de desenvolvimento (via cliente SQL):

```sql
WITH organization AS (
  INSERT INTO app.organizations (name) VALUES ('Desenvolvimento local') RETURNING id
)
INSERT INTO app.workspaces (organization_id, name)
SELECT id, 'Uploads locais' FROM organization RETURNING id;
```

Em `.env.local`, mantenha DATABASE_URL e configure:

```dotenv
ENABLE_LOCAL_UPLOAD=true
DEV_UPLOAD_WORKSPACE_ID=<UUID retornado pelo SQL>
LOCAL_UPLOAD_ORIGIN=http://127.0.0.1:3000
LOCAL_STORAGE_ROOT=.local/raw-storage
MAX_UPLOAD_BYTES=10485760
```

Não versione `.env.local`, arquivos raw ou credenciais. O storage deve ficar fora de
`public`, em diretório privado controlado pelo operador. Inicie explicitamente em loopback:

```sh
npm run dev -- --hostname 127.0.0.1
```

Abra `http://127.0.0.1:3000/data/upload`, selecione um `.csv` não vazio e envie.
Nome do dataset é opcional. A UI mostra nome, arquivo, tamanho e PROCESSING / aguardando
processamento; IDs ficam em detalhes. Não há parsing, preview, polling, profiling,
criação de DatasetColumn ou processamento em background.

API: `POST /api/workspaces/{workspaceId}/datasets`, multipart com exatamente um `file`
e opcionalmente `name`. Origin/Host devem corresponder a LOCAL_UPLOAD_ORIGIN.
Campos adicionais, incluindo organizationId, datasetId, datasetVersionId, storageKey
e sourceType, são rejeitados. Limite configurável de 10 MiB com contagem dos bytes reais,
envelope adicional de até 64 KiB e timeout de recebimento de 60 segundos. Não há limite
de concorrência por processo. Extensão/MIME não validam a estrutura interna do CSV.

Resposta 201:

```json
{
  "dataset": { "id": "UUID", "workspaceId": "UUID", "name": "Vendas" },
  "version": {
    "id": "UUID",
    "versionNumber": 1,
    "sourceType": "CSV",
    "status": "PROCESSING",
    "originalFilename": "vendas.csv",
    "sizeBytes": 20
  }
}
```

Erros retornam `{error: {code, message, requestId}}`: 400 entrada inválida, 403 origem,
404 indisponível, 408 timeout, 413 tamanho, 415 tipo, 500 storage/interno, 503 banco/resultado
incerto. O resultado incerto não deve ser repetido automaticamente: pode ter sido persistido.

Layout privado, com namespace lógico `raw`:

```text
.local/raw-storage/
├── .staging/{UUID temporário}
└── workspaces/{workspaceId}/versions/{datasetVersionId}/raw.csv
```

Publicação usa hard link exclusivo no mesmo volume; nunca usa o nome original como caminho.
O filesystem precisa suportar hard links. Não há transação PostgreSQL durante o recebimento.
Após publicação, uma transação curta insere os dois registros. Rollback confirmado permite
compensação; COMMIT incerto preserva o raw. Quedas e falhas de limpeza podem deixar órfãos.
Não há reconciliação automática nem garantia WORM contra o administrador do filesystem.
Veja [ADR-004](docs/adr/ADR-004-local-raw-storage.md) para consistência e limites.

Para conferir manualmente, use o ID da versão mostrado nos detalhes:

```sql
SELECT d.name, v.original_filename, v.size_bytes, v.status, v.source_type,
       v.storage_namespace, v.storage_key,
       (SELECT count(*) FROM app.dataset_columns c WHERE c.dataset_version_id = v.id) AS columns
FROM app.dataset_versions v JOIN app.datasets d ON d.id = v.dataset_id
WHERE v.id = '<UUID da versão>';
```

Confirme PROCESSING, CSV, zero colunas e o arquivo em LOCAL_STORAGE_ROOT/storage_key.
A migração T-004 adiciona original_filename e size_bytes; não altera as migrações anteriores.

### Regressão da UI de upload

Com o servidor de desenvolvimento acima ativo e o contexto local configurado, execute
`npm run test:upload-ui`. A suíte usa Edge instalado no Windows; em outros sistemas,
instale Chromium com `npx playwright install chromium`. Para outra porta, exporte
`UPLOAD_UI_BASE_URL` com a URL local correspondente.

Os testes verificam hidratação, bloqueio de envio sem JavaScript e POST multipart sem
navegação, além dos estados de sucesso/erro. As respostas do endpoint são interceptadas
nesses testes de UI: eles não gravam arquivos nem registros no banco. A integração real
do backend continua em `npm run test:integration`.

`next.config.ts` permite somente o host adicional `127.0.0.1` nos recursos de desenvolvimento
do Next.js. Sem isso, acessar por esse IP um servidor iniciado com hostname diferente pode
bloquear o canal HMR/debug e impedir a hidratação. Reinicie `npm run dev` após atualizar
a configuração. O formulário permanece desabilitado até a hidratação conectar seu handler;
as variáveis de ambiente e a resolução do workspace continuam no servidor.

## Verificações

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
```

O typecheck gera os tipos de rotas antes de executar o TypeScript, inclusive em checkout limpo.
`npm run check` agrupa typecheck, lint, formatação e testes.
`npm run format` formata o bootstrap, preservando os documentos originais de contexto.
O Vitest usa o ambiente Node e `react-dom/server`, sem jsdom ou Testing Library.

Com o servidor de produção ativo, em outro terminal PowerShell:

```powershell
$response = Invoke-WebRequest http://localhost:3000 -UseBasicParsing
if ($response.StatusCode -ne 200 -or $response.Content -notmatch '<h1>Analytics AI</h1>') {
  throw 'Falha no smoke check'
}
```

Encerre o servidor com Ctrl+C após a verificação.

## Estrutura

- `src/app/`: layout, página inicial, `/data/upload` e endpoint de upload.
- `src/modules/dataset/`: validação, recebimento e persistência do upload; demais módulos permanecem placeholders.
- `src/lib/storage/`: contrato RawStorage e implementação local.
- `tests/unit/`: bootstrap, configuração, streaming, storage e compensação do upload.
- `src/lib/db/`, `scripts/db/`, `migrations/`: conexão de metadados e migrações administrativas.
- `tests/integration/`: verificação opt-in com PostgreSQL real.
- `docs/adr/`: decisões de infraestrutura e migrações.
- `docs/` e `tasks/`: documentos de produto, arquitetura e tickets.

Git foi inicializado localmente. CI de provedor fica pendente da escolha da hospedagem do repositório; os comandos acima podem ser reutilizados no pipeline.

## Contexto do projeto

- [Instruções do projeto](AGENTS.md)
- [PRD](docs/PRD.md)
- [TDD](docs/TDD.md)
- [EPIC-01](tasks/EPIC-01-data-foundation.md)
- [Prompt T-001](tasks/T-001-prompt.md)

T-001 a T-008 concluídos. T-009 implementado para revisão; nenhum próximo ticket iniciado.

## Processamento explícito local — T-007

Com Node 22.23.2, PostgreSQL migrado e um CSV recebido pelo T-004:

```sh
npm run dataset:process -- --version-id <UUID-da-versao>
```

O comando lê `.env.local`: DATABASE_URL, LOCAL_STORAGE_ROOT, MAX_UPLOAD_BYTES,
ENABLE_LOCAL_UPLOAD=true e DEV_UPLOAD_WORKSPACE_ID. NODE_ENV deve estar ausente ou ser
`development`; produção é bloqueada. Esse contexto temporário NÃO é autenticação,
autorização ou segurança de tenant. O workspace vem somente do servidor; o caminho vem
dos metadados existentes, nunca de um argumento de arquivo. O upload continua PROCESSING.

O processamento explícito lê o raw sem alterá-lo e persiste DatasetColumns, contagens e READY
na mesma transação curta. Não cria preview, endpoint ou processamento automático.
Estados finais retornam ALREADY_TERMINAL sem alterações. Falhas determinísticas de CSV/raw
podem marcar FAILED; indisponibilidade de infraestrutura mantém PROCESSING quando confirmado.
PROCESSING_OUTCOME_UNKNOWN exige consultar o estado antes de tentar novamente: o commit
pode ter sido efetivado. Não há retry automático nem limpeza de arquivos.

CSV: UTF-8, vírgula, cabeçalho, aspas duplas; inferência completa e estrita. Nomes duplicados/vazios
são normalizados pelo DuckDB. Tipos físicos são preservados, inclusive DOUBLE; não representam
tipos monetários/semânticos. nullable=true se há NULL; caso contrário NULL (desconhecido).
A inferência é específica desta versão do raw. profile_metadata permanece NULL.

`npm run test:integration` requer TEST_DATABASE_URL para um banco de testes vazio e separado.
Inclui fixtures reais, rollback, visibilidade, concorrência e perda da confirmação de COMMIT.
O binding DuckDB é runtime apenas do comando; build Next.js aprovado não comprova bundling
em rotas nem compatibilidade com deploy futuro. Nenhuma migration nova é necessária.

## Data Preview local — T-008

Com o mesmo contexto local do upload e `npm run dev`, abra `/data`. A lista mostra até
50 datasets recentes do workspace configurado no servidor. Clique no nome para abrir
`/data/datasets/<datasetId>`; `?version=<datasetVersionId>` seleciona uma versão específica.
Sem esse parâmetro, a versão de maior número é selecionada, mesmo se ainda estiver PROCESSING.

READY mostra metadados, schema persistido e até 50 linhas do raw. PROCESSING e FAILED não
abrem DuckDB. Incompatibilidade raw/schema mostra erro seguro de preview e mantém READY.
O preview não processa, reinfere, corrige, persiste linhas ou altera o lifecycle.
Cada célula transporta `{ column, value }`, com valor textual ou NULL. DECIMAL/BIGINT não
passam por Number; DOUBLE permanece aproximado. A tabela não fornece filtros ou ordenação.

O contexto continua exclusivo de desenvolvimento e não implementa autenticação/segurança
de tenant. As rotas respondem 404 em produção, mesmo com as flags locais configuradas.
O preview usa Suspense após verificar existência/escopo, preservando HTTP 404 real.
Sem JavaScript, os metadados/schema continuam visíveis; a substituição do preview em streaming
requer JavaScript. Não há polling nem retry automático.

Testes adicionais:

```sh
# Com npm run dev ativo e uma versão READY no workspace de .env.local:
npm run test:preview-ui
npm run test:upload-ui

# Sem servidor nas portas 3010/3011:
npm run build
npm run test:preview-runtime
```

O teste de UI lê o dataset real sem criar fixtures no banco da aplicação e compara snapshots
das cinco tabelas de domínio e SHA-256 do raw antes/depois. Os testes de integração usam
somente um TEST_DATABASE_URL vazio/separado, como nas etapas anteriores.

O teste runtime primeiro inicia o artefato real e verifica o bloqueio de produção. Depois
gera apenas uma rota/configuração temporárias em `.local`, importa a MESMA implementação
`readDatasetPreview`, compila/inicia Next e executa uma consulta real. Não copia a aplicação,
não conecta ao PostgreSQL e remove seu harness ao terminar com sucesso.

`serverExternalPackages: ["@duckdb/node-api"]` foi necessário: sem isso, o build tentou
resolver bindings nativos de outras plataformas. O pacote e seu binário da plataforma devem
acompanhar o deploy. O runtime compilado foi validado localmente; outros alvos de deploy
continuam não verificados. Consulte [o relatório T-008](docs/T-008-data-preview.md).

## Agregação ground truth — T-009

Com uma DatasetVersion READY do fluxo local, execute:

```sh
npm run dataset:ground-truth -- --version-id <UUID-da-versao>
```

O comando usa o workspace configurado somente no servidor e permanece bloqueado em produção.
Ele conhece apenas o cálculo de encerramento do EPIC-01:
`SUM(quantidade * preco_unitario)`. Não recebe SQL, expressão, path ou storage key e não é um
Query Engine, Semantic Query ou Metric. Não há endpoint/UI, persistência de resultado ou alteração
de lifecycle.

Os operandos são relidos do texto original como DECIMAL(18,0) e DECIMAL(18,2), sem converter
o DOUBLE persistido de volta para decimal. DuckDB 1.5.5 produziu DECIMAL(18,2) para o produto e
DECIMAL(38,2) para SUM. O total atravessa a fronteira como string, sem Number ou arredondamento.
NULL em qualquer operando exclui a linha; nenhuma contribuição retorna null, enquanto soma zero
retorna `"0.00"`. Entradas fora do contrato ou overflow falham com mensagem segura.

No dataset real, o resultado foi `"2059.61"` para 20 de 20 linhas, igual ao Python Decimal
independente do SP-01. Snapshots das cinco tabelas e SHA-256 do raw ficaram inalterados.
Consulte [o relatório T-009](docs/T-009-ground-truth-aggregation.md).
