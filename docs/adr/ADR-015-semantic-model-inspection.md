# ADR-015 — Semantic Model Inspection

Status: aceito e implementado no T-014.

## Fronteira de leitura

`SemanticModelInspection` é o contrato read-only entre a metadata semântica persistida e futuros
consumidores. Ele expõe SemanticModel, revision, Dataset/DatasetVersion, fields e metrics sem
revelar o schema PostgreSQL, JSONB cru, SQL, query plans ou referências de storage.

Há duas operações internas: uma resolve a revisão `PUBLISHED` ativa de um SemanticModel; a outra
inspeciona uma SemanticModelRevision específica em qualquer estado. Ambas são workspace-scoped.
Workspace incorreto retorna `NOT_FOUND` sem revelar a existência do recurso.

## Identidades e lineage

Fields usam `fieldKey`; metrics usam `metricKey`. IDs das linhas SemanticField, Metric e
DatasetColumn não pertencem ao contrato. O lineage necessário contém somente `physicalName`,
`physicalType` e `ordinalPosition`.

Cada metric contém o AST v1 normalizado, `resultType` derivado e dependencies distintas ordenadas
por `fieldKey`. Nenhum result type é persistido e nenhuma metric é executada.

## Consistência e fail-safe

A inspeção reutiliza `validateSemanticRevisionContent` do T-013 e
`validateMetricExpression` do T-012. Divergência entre AST e `metric_field_references`, lineage
inválido, field desconhecido ou falha de inferência retorna `INCONSISTENT_SNAPSHOT`; nenhum
snapshot parcial é entregue e nenhum repair é tentado.

Cada operação executa integralmente em `REPEATABLE READ READ ONLY`. A seleção da revisão publicada,
DatasetVersion, fields, metrics, references, validação e montagem pertencem ao mesmo snapshot MVCC.
Isso produz uma visão consistente de DRAFTs concorrentes e de substituições de publicação sem
adicionar `FOR SHARE` ou bloquear writers.

São quatro queries de metadata: resolução, fields com lineage, metrics e references. Não há N+1,
cache, migration, endpoint HTTP, UI, DuckDB ou SQL analítico.

## Ordenação

- fields: ordinal position, com fieldKey como desempate;
- metrics: name, com metricKey como desempate;
- dependencies: fieldKey;
- issues: ordenação determinística herdada do T-013.

O EPIC-03 poderá consumir uma inspeção publicada consistente, mas continuará responsável por
conversão física, compilação e execução analítica.
