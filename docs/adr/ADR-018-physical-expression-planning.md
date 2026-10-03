# ADR-018 — Physical Expression Planning

Status: aceito e implementado no T-017.

## Boundary

T-017 separa duas operações. `resolveAnalyticalSource` usa PostgreSQL e storage local para resolver
uma DatasetVersion READY, workspace-scoped e CSV em `AuthorizedAnalyticalSource`.
`planPhysicalQuery` combina essa fonte com `ResolvedSemanticQuery` e produz `PhysicalQueryPlan` de
forma pura, síncrona e determinística. O planner não acessa PostgreSQL, filesystem, DuckDB ou SQL.

O escopo de workspace é uma precondição interna fornecida pelo servidor; não implementa
autenticação ou autorização de usuário. Workspace incorreto retorna NOT_FOUND.

## Material local

O path concreto fica em um material handle opaco criado pela infraestrutura Dataset. O plan
preserva somente o handle, size e identidade stat; path não é propriedade enumerável, DTO, erro ou
parte da linguagem física. `withAnalyticalMaterial` é a boundary confiável que poderá entregar o
path ao futuro executor. O compiler não receberá `pathString` arbitrário.

A resolução usa transação curta REPEATABLE READ READ ONLY e faz COMMIT antes do filesystem. Depois
valida containment, chave controlada pelo servidor, arquivo regular, ausência de symlink, size e
identidade material. Não calcula SHA-256 por query. Persistir hash na ingestão permanece hardening
futuro.

## CSV e schema

Somente CSV é suportado. O plano exige header, quantidade e ordem exatas de colunas, nomes sem
duplicatas, row shape estrito e row count esperado. Todas as colunas são inicialmente lidas como
texto. A política atual considera campo vazio, quoted ou não, como NULL.

`DatasetColumn.inferred_type` é metadata usada para lineage, compatibilidade e escolha da policy.
Não é uma ordem para rematerializar nem revalidar globalmente os valores contra o tipo histórico.
Somente fields usados recebem `SourceConversionPolicy`; valores de colunas não utilizadas não
invalidam a query.

## Conversões

As policies fechadas cobrem STRING, BOOLEAN, INTEGER, DECIMAL, NUMBER, DATE, DATETIME, INSTANT e o
caso UUID textual já admitido pelo T-011. BOOLEAN aceita inicialmente somente `true`/`false` em
lowercase. DATE, DATETIME e INSTANT usam formatos ISO fechados; DATETIME não inventa timezone e
INSTANT exige UTC `Z`. STRING não sofre trim ou normalização Unicode e rejeita NUL.

DECIMAL(p,s) usa `TEXT_TO_EXACT_DECIMAL`: sem scientific notation, ROUND, truncamento ou redução de
scale. DOUBLE inferido para DECIMAL continua lendo o raw textual diretamente; não existe strategy
DOUBLE_TO_DECIMAL. Uma futura fonte contendo somente DOUBLE materializado não satisfará esse
contrato exato.

Semantic INTEGER materializa como HUGEINT, mas operações mistas com DECIMAL não recebem uma regra
global INTEGER-to-DECIMAL(38,0). O BINARY declara `EXACT_DECIMAL`, result type e overflow. T-018
deverá escolher e provar a realização DuckDB.

Semantic NUMBER declara `TEXT_TO_FINITE_DOUBLE`, com overflow, underflow para zero e non-finite como
erros. O planner preserva o texto, inclusive valores extremos, sem JavaScript Number nem uma
reimplementação IEEE-754. A validação autoritativa pertence ao compiler/executor.

## Physical plan

O AST físico fechado contém SOURCE_FIELD, LITERAL, BINARY e AGGREGATE. BINARY distingue
EXACT_INTEGER, EXACT_DECIMAL e APPROXIMATE_DOUBLE. COUNT e COUNT_DISTINCT retornam BIGINT físico e
INTEGER semântico. Filters carregam expressions/literals, dimensions precedem metrics, order usa
outputIndex interno com NULLS LAST, e semanticLimit permanece ausente ou idêntico ao input. Safety
cap não pertence ao plan.

O compiler futuro consumirá somente `PhysicalQueryPlan` e a boundary confiável de materialização.
Não receberá SemanticModelInspection, SemanticQueryV1 ou ResolvedSemanticQuery.

## Segurança e erros

Physical names permanecem dados; quoting pertence ao T-018. O planner confere dataset/version e o
lineage exato contra a fonte autorizada, revalida Metric AST/dependencies/resultType como
invariantes e nunca concatena SQL. Outputs e erros não expõem path, storage key, SQL, literals ou
exceptions internas.

Planner outcomes: PLANNED, SOURCE_MISMATCH, UNSUPPORTED_SOURCE_TYPE,
UNSUPPORTED_PHYSICAL_CONVERSION e INCONSISTENT_RESOLVED_QUERY. Source resolver outcomes: RESOLVED,
NOT_FOUND, NOT_READY, UNSUPPORTED_SOURCE_TYPE, SOURCE_UNAVAILABLE, SOURCE_INTEGRITY_FAILED e
OPERATIONAL_FAILURE.

O plano é reconstruído e congelado profundamente. Não carrega Date, clock, random ou engine
introspection. Não houve migration ou dependência nova.
