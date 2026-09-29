# EPIC-02 — Semantic Layer Foundation

**Status:** T-014 IMPLEMENTED — EPIC-02 AWAITING REVIEW
**Stage:** Technical Alpha

## Goal

Definir, validar, versionar e publicar significado semântico sobre o schema físico persistido no
EPIC-01. Compilação e execução desse significado pertencem ao EPIC-03.

## Backlog aprovado

1. T-010 — Semantic Model & Revisions
2. T-011 — Semantic Fields & Type System
3. T-012 — Metrics & Expression AST
4. T-013 — Validation & Publication
5. T-014 — Semantic Model Inspection

## T-010 — Semantic Model & Revisions

Implementar apenas a identidade estável do SemanticModel, revisões ligadas a DatasetVersion e a
criação idempotente de um draft sobre uma versão READY. T-010 não publica nem arquiva revisões e
não cria SemanticField, Metric ou AST.

`published_at` preservará o instante original de publicação inclusive depois da futura transição
para ARCHIVED. A igualdade de payload na criação é somente uma regra de idempotência; drafts serão
editáveis nos tickets seguintes.

## T-011 — Semantic Fields & Type System

Implementar SemanticField em revisões DRAFT, com field_key lógico, vínculo físico garantido por FKs
compostas, type system mínimo e matriz SAFE/EXPLICIT/INVALID. TypeCompatibility descreve
admissibilidade de intenção, não disponibilidade de conversão analítica. DOUBLE → DECIMAL é
EXPLICIT; DATE → DATETIME é INVALID. Não há execução DuckDB, metrics, AST ou publicação.

## T-012 — Metrics & Expression AST

Implementar Metric e um AST v1 fechado, declarativo e independente do engine. Expressions usam
field_key e persistem atomicamente uma projeção relacional mínima para integridade. A raiz é uma
agregação; não há SQL, compilação ou execução DuckDB. Result type é derivado. Alterações em fields
não podem deixar Metrics inválidas ou órfãs. Publicação permanece T-013.

## T-013 — Validation & Publication

Implementar validação determinística e read-only do snapshot, separada da elegibilidade de
publication. Um snapshot publicável exige DatasetVersion READY, ao menos um SemanticField e uma
Metric, lineage e tipos válidos, AST inferível e projeção de referências exata.

Publication bloqueia SemanticModel e SemanticModelRevision, valida dentro da transação, arquiva a
revisão publicada anterior e publica o draft atomicamente. Triggers PostgreSQL específicos tornam
metadata e conteúdo de revisões PUBLISHED/ARCHIVED imutáveis e preservam o `published_at` original.
Não há archive API pública, execução DuckDB, compilação ou T-014 neste ticket.

## T-014 — Semantic Model Inspection

Implementar `SemanticModelInspection` como fronteira read-only e independente do PostgreSQL para a
revisão PUBLISHED ativa ou uma revision específica. Fields expõem fieldKey, tipo semântico e
lineage físico sem PKs internas. Metrics expõem metricKey, AST normalizado, resultType derivado e
dependencies por fieldKey.

Toda resolução ocorre em um único snapshot `REPEATABLE READ READ ONLY`. A validação do T-013 é
reutilizada; inconsistências retornam issues sem snapshot parcial ou repair. Não há migration,
cache, endpoint, UI ou execução analítica.

## EPIC-02 completion gate

O epic entrega o fluxo DatasetVersion → SemanticModel → revisions → fields/metrics tipados →
validation → publication imutável → inspection. Um futuro EPIC-03 pode consumir o snapshot
publicado sem conhecer o schema PostgreSQL, interpretar JSONB cru ou reconstruir type inference e
dependencies. Conversão física, compilação e execução continuam fora deste epic.

## Precisão

`DECIMAL` futuro representa intenção semântica, precision e scale. Isso não basta para decidir a
conversão física: converter um DOUBLE materializado não recupera necessariamente o texto decimal
original. O EPIC-03 deverá distinguir essas situações ao compilar. Nenhuma compilação pertence a
este epic.

## Out of scope do T-010

- SemanticField e field_key;
- Metric e metric_key;
- Expression AST;
- publicação e arquivamento;
- imutabilidade completa de conteúdo;
- Query Engine ou DuckDB;
- endpoint, UI, autenticação, autorização ou RLS;
- IA, dashboards ou próximo epic.
