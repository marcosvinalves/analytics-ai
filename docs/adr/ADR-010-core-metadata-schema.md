# ADR-010 — Schema mínimo de metadados

Status: aceito no T-003, em 19/09/2026.

## Escopo e ownership

Implementamos somente cinco tabelas no schema `app`:

```text
organizations → workspaces → datasets → dataset_versions → dataset_columns
```

Organization é a fronteira do tenant. Cada filho possui exatamente uma FK obrigatória para seu pai.
Cada pai pode ter zero ou mais filhos. Não duplicamos IDs de ancestrais nos descendentes.
As FKs impedem órfãos e cadeias contraditórias, mas não autorizam acesso nem impedem reassociação
para outro pai existente. `ON UPDATE RESTRICT` protege a chave referenciada, não a troca de FK.
Autorização e eventual RLS são trabalho futuro.

Dataset identifica o conjunto lógico; DatasetVersion identifica uma versão de um artefato bruto imutável.
Status, contagens e schema detectado são preenchidos durante o processamento. Checks validam o estado
de cada linha, não transições históricas nem a imutabilidade de um objeto externo.

## Colunas comuns

Todas as tabelas possuem:

| Coluna     | Tipo        | NULL | Default           |
| ---------- | ----------- | ---- | ----------------- |
| id         | uuid, PK    | Não  | gen_random_uuid() |
| created_at | timestamptz | Não  | CURRENT_TIMESTAMP |
| updated_at | timestamptz | Não  | CURRENT_TIMESTAMP |

UUIDv4 é gerado no banco, sem extensão ou dependência nova. Sua compatibilidade e simplicidade são
adequadas à Alpha; UUIDv7 oferece melhor localidade de inserção, mas não há necessidade demonstrada.
O default não proíbe IDs explicitamente fornecidos por um escritor SQL; a aplicação deverá gerar/omitir IDs
no servidor, sem confiar nos fornecidos por clientes. UUID não é autorização.

`timestamptz` preserva o instante, não o nome do fuso original. Serializar com offset explícito/UTC.
A função `app.set_updated_at()` e cinco triggers `BEFORE UPDATE` usam `statement_timestamp()`.
Eles fazem exclusivamente manutenção de timestamps: não são mecanismo de versionamento, autorização,
imutabilidade ou proteção contra alterações de `created_at`.

## Colunas específicas

Além das colunas comuns, as tabelas contêm os campos abaixo.
Campos obrigatórios não têm default, salvo `status`; campos opcionais têm default implícito NULL.

| Tabela           | Coluna                   | Tipo          | NULL | Regra                                             |
| ---------------- | ------------------------ | ------------- | ---- | ------------------------------------------------- |
| organizations    | name                     | text          | Não  | btrim(name) não vazio                             |
| workspaces       | organization_id          | uuid          | Não  | FK organizations(id)                              |
| workspaces       | name                     | text          | Não  | Não vazio                                         |
| datasets         | workspace_id             | uuid          | Não  | FK workspaces(id)                                 |
| datasets         | name                     | text          | Não  | Não vazio                                         |
| datasets         | description              | text          | Sim  | Descrição opcional                                |
| dataset_versions | dataset_id               | uuid          | Não  | FK datasets(id)                                   |
| dataset_versions | version_number           | integer       | Não  | > 0                                               |
| dataset_versions | source_type              | text          | Não  | btrim(source_type) não vazio                      |
| dataset_versions | storage_namespace        | text          | Não  | Não vazio                                         |
| dataset_versions | storage_key              | text          | Não  | Não vazio                                         |
| dataset_versions | status                   | text          | Não  | Default PROCESSING; CHECK de estados              |
| dataset_versions | row_count                | bigint        | Sim  | >= 0                                              |
| dataset_versions | column_count             | integer       | Sim  | >= 0                                              |
| dataset_versions | processing_error_code    | varchar(64)   | Sim  | Não vazio quando informado                        |
| dataset_versions | processing_error_message | varchar(2000) | Sim  | Mensagem segura                                   |
| dataset_versions | processed_at             | timestamptz   | Sim  | >= created_at quando informado                    |
| dataset_columns  | dataset_version_id       | uuid          | Não  | FK dataset_versions(id)                           |
| dataset_columns  | physical_name            | text          | Não  | Não vazio                                         |
| dataset_columns  | inferred_type            | text          | Não  | Não vazio; vocabulário a consolidar na inferência |
| dataset_columns  | ordinal_position         | integer       | Não  | >= 1                                              |
| dataset_columns  | nullable                 | boolean       | Sim  | NULL = desconhecido                               |
| dataset_columns  | null_count               | bigint        | Sim  | >= 0; NULL = desconhecido                         |
| dataset_columns  | profile_metadata         | jsonb         | Sim  | Objeto JSON quando informado                      |

`source_type` não usa enum nem CHECK de vocabulário. A aplicação decidirá os tipos suportados;
aceitar texto no banco não implementa conectores. `inferred_type` não é SQL executável nem tipo DuckDB.
`storage_namespace` e `storage_key` são referências lógicas/opacas: nunca bytes, credenciais ou URLs assinadas.
O banco valida presença/unicidade, não interpreta essas strings nem garante o conteúdo do storage.
O fluxo futuro armazena o artefato antes de inserir DatasetVersion.
`profile_metadata` é opcional e não define um sistema de profiling; evitar amostras sensíveis.

Não persistimos `null_ratio`: derivar com divisão decimal de `null_count` por `row_count`.
Quando as contagens são desconhecidas ou row_count é zero, a razão é NULL.

## Status e checks

Preferimos `text` com CHECK nomeado a ENUM nativo: mantém a evolução do conjunto de estados em migrações SQL simples.

| Status     | processed_at | Contagens                                             | Erros                                           |
| ---------- | ------------ | ----------------------------------------------------- | ----------------------------------------------- |
| PROCESSING | NULL         | Opcionais, não negativas                              | Código e mensagem NULL                          |
| READY      | Obrigatório  | row_count >= 0 e column_count > 0, ambos obrigatórios | Código e mensagem NULL                          |
| FAILED     | Obrigatório  | Opcionais/parciais                                    | Código obrigatório não vazio; mensagem opcional |

`dataset_versions_status_valid` limita os valores aos três estados acima.
`dataset_versions_processing_consistent` usa IS NULL/IS NOT NULL explicitamente, impedindo combinações
inválidas de atravessar o CHECK por resultado desconhecido.
Há também checks nomeados para textos obrigatórios não vazios, valores não negativos, ordinal/versão
positivos, código de erro não vazio, ordem dos timestamps e objeto JSON de profiling.
O SQL da migração é a referência exata para os nomes e expressões de todas as constraints.

## Unicidade e índices

Não há unicidade nos nomes de organização, workspace ou dataset.
Há quatro constraints UNIQUE, que também fornecem índices B-tree:

- dataset_versions_number_unique: (dataset_id, version_number).
- dataset_versions_storage_unique: (storage_namespace, storage_key).
- dataset_columns_ordinal_unique: (dataset_version_id, ordinal_position).
- dataset_columns_name_unique: (dataset_version_id, physical_name), sensível a maiúsculas/minúsculas na collation padrão determinística.

Além dos cinco índices das PKs, criamos somente:

- workspaces_organization_idx: (organization_id).
- datasets_workspace_idx: (workspace_id).

Total: 11 índices. Índices únicos compostos já cobrem o prefixo das FKs de versões/colunas.
Não há índices de status, JSONB ou busca textual.

## Exclusão e migração

As quatro FKs usam ON DELETE RESTRICT ON UPDATE RESTRICT, sem cascata ou soft delete.
Uma exclusão futura deverá tratar descendentes e arquivos explicitamente.

`202609190002_create_core_metadata.sql` preserva a migração T-002 existente.
O runner continua explícito, transacional, com histórico em `migration_metadata.history` e advisory lock.
O DOWN remove tabelas na ordem inversa e depois a função de timestamps, sempre com RESTRICT.
Esse rollback perde os dados das tabelas; não é executado automaticamente e só é testado em banco descartável.

## Limites e riscos

- A futura alocação concorrente de version_number precisa de transação/coordenação; MAX + 1 isolado não basta.
- Cabeçalhos duplicados precisarão de validação/normalização explícita antes de persistir physical_name.
- null_count <= row_count e column_count igual à quantidade de colunas dependem de validação entre tabelas no processamento futuro.
- bigint pode exceder a precisão de number em JavaScript; `pg` preserva esses valores como strings por padrão.
- Índices B-tree em referências textuais pressupõem chaves compactas; o futuro storage deve definir limites de tamanho.
- Checks não implementam a máquina de estados T-005, autorização ou imutabilidade histórica.
- Não há usuários, memberships, upload, storage adapter, repositórios, APIs, UI ou motor analítico neste ticket.

## Testes

Integração em PostgreSQL real: banco limpo, upgrade T-002, rollback explícito T-003 e reaplicação;
UUIDs, timestamps, FKs, ownership de duas organizações, RESTRICT, unicidade, status, NULLs,
contagens, perfil JSON e catálogo de índices/triggers.
Fixtures usam transações revertidas, sem seeds de produção e sem exigir CREATEDB do usuário dos testes.

## Extensão aditiva T-004

A migração `202609190003_add_upload_metadata.sql` acrescenta em `app.dataset_versions`
`original_filename text NULL` com CHECK nomeado de texto não vazio e `size_bytes bigint NULL`
com CHECK nomeado de valor positivo. Ambos têm default implícito NULL para compatibilidade
com registros anteriores; o upload T-004 sempre fornece os dois valores.
Nenhuma tabela, FK ou índice adicional foi criado. A migração T-003 permanece inalterada.
O filename é somente metadado de exibição; os bytes ficam no storage descrito no ADR-004.
