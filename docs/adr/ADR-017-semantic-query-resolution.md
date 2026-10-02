# ADR-017 — Semantic Query Validation & Resolution

Status: aceito e implementado no T-016.

## Boundary pura

`resolveSemanticQuery(query, inspection)` transforma uma `SemanticQueryV1` estruturalmente válida
e uma `SemanticModelInspection` PUBLISHED em `ResolvedSemanticQuery`. A operação é síncrona, pura e
determinística. Não acessa PostgreSQL, DuckDB, SQL, CSV, filesystem, storage ou configuração.

O T-014 continua responsável por produzir um snapshot consistente. O T-016 acrescenta a
elegibilidade para execução: DRAFT e ARCHIVED retornam `REVISION_NOT_PUBLISHED`. O resolver não
repete a validação interna da inspection.

## Resolução

Metrics são resolvidas por metricKey. AST normalizado, result type e dependencies vêm
exclusivamente da inspection. Cada dependency é expandida para um `ResolvedField`, permitindo ao
planejamento futuro consumir type e lineage sem refazer lookup semântico. Dimensions e filters
também carregam o mesmo field reconstruído. Mapas por key existem somente durante a função.

O contrato resolvido preserva apenas contexto executável: IDs e nomes do modelo/dataset,
identidade e label da revision, DatasetVersion, names/labels de fields e metrics, types, lineage,
AST e dependencies. Descriptions não são copiadas. `publishedAt` continua `Date`, mas usa uma nova
instância criada pelo valor temporal da inspection; não há referência Date compartilhada nem
serialização ISO neste boundary.

Dimensions preservam a ordem da query e precederão Metrics no resultado futuro. A ordem interna de
Metrics, filters e orderBy também é preservada. O limit semântico é copiado somente quando existe;
nenhum default ou safety result cap é inserido.

## Filters

EQ, NEQ e IN aceitam todos os SemanticTypes, sempre com correspondência literal/type exata.
GT/GTE/LT/LTE aceitam apenas INTEGER, DECIMAL, NUMBER, DATE, DATETIME e INSTANT. IS_NULL e
IS_NOT_NULL aceitam qualquer tipo, independentemente do profile de NULL observado.

DECIMAL literals são comparados textualmente com precision e scale do field. Excesso de scale ou
dígitos inteiros é rejeitado sem Number, cast, arredondamento ou truncamento. INTEGER não recebe
precision inventada. NUMBER extremo permanece semanticamente válido; capacidade física pertence ao
T-017. Temporals exigem o mesmo SemanticType e não são convertidos.

## Erros e segurança

Keys desconhecidas, filtros incompatíveis e orderBy fora do output retornam issues determinísticas,
sem exceptions de input, valores sensíveis ou cascatas artificiais. São coletadas no máximo 32
issues. A query não pode fornecer AST, result type, label, lineage, DatasetVersion ou source.

O resultado é reconstruído e suas estruturas são congeladas profundamente. Congelar um `Date` não
torna seu estado temporal interno imutável; a garantia relevante é que a instância de output não é
a mesma da inspection e mutações nela não alteram o input.

Não há migration ou dependência nova. Planejamento físico e source resolution continuam no T-017.
