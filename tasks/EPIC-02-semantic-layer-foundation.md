# EPIC-02 — Semantic Layer Foundation

**Status:** T-010 IMPLEMENTED — AWAITING REVIEW
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
