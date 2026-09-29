# EPIC-03 — Query Foundation

**Status:** T-015 IMPLEMENTED — AWAITING REVIEW
**Stage:** Technical Alpha

## Goal

Transformar uma Semantic Query estruturada em resultado analítico seguro, determinístico, tipado e
explicável. A IA não participa do pipeline. Semantic Query e Metric AST nunca contêm SQL; somente o
compiler físico poderá gerar SQL analítico.

## Backlog aprovado

1. T-015 — Semantic Query Contract
2. T-016 — Semantic Query Validation & Resolution
3. T-017 — Physical Expression Planning
4. T-018 — DuckDB Query Compiler
5. T-019 — Query Execution & Typed Results
6. T-020 — Query Explainability & Lineage
7. T-021 — Query Foundation Vertical Slice

## T-015 — Semantic Query Contract

Implementar apenas o parser estrutural `unknown → SemanticQueryV1`. A V1 possui metrics,
dimensions, filters com AND implícito, orderBy e limit semântico opcional. Keys usam as identidades
lógicas metricKey/fieldKey; não há SQL, nomes físicos ou IDs internos.

Literals são discriminados e preservam intenção. INTEGER, DECIMAL e NUMBER são textuais; NUMBER
não é convertido para JavaScript number. Temporais usam formatos ISO estritos, e INSTANT aceita
somente UTC `Z`. NULL é expresso somente por operadores próprios.

O parser aplica exact keys, limites estruturais, reconstrução e deep freeze. A representação
canônica de até 16 KiB é metadata do parser, não identidade, hash, cache, histórico ou parte de
`SemanticQueryV1`. Limit semântico e safety result cap são conceitos separados.

T-015 não importa `SemanticModelInspection`, não resolve keys e não acessa PostgreSQL, DuckDB, SQL,
filesystem ou storage. Não há migration ou dependência nova. T-016 não foi iniciado.

## Architecture boundary

```text
unknown
  ↓
parseSemanticQuery
  ↓
SemanticQueryV1
```

Somente o T-016 poderá combinar `SemanticQueryV1` e `SemanticModelInspection` para produzir uma
consulta resolvida.

## Out of scope do T-015

- resolução de metricKey ou fieldKey;
- compatibilidade entre fields, filters e order targets;
- source resolution ou paths;
- planejamento físico e política DuckDB;
- compilação ou execução;
- result contract ou explainability;
- endpoint, UI, Ask, dashboards ou IA;
- persistência, cache ou histórico de queries.
