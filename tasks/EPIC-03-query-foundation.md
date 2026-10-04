# EPIC-03 — Query Foundation

**Status:** T-018 IMPLEMENTED — AWAITING REVIEW
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
filesystem ou storage. Não houve migration ou dependência nova.

## T-016 — Semantic Query Validation & Resolution

Implementar `resolveSemanticQuery(SemanticQueryV1, SemanticModelInspection)` como serviço de domínio
puro. Somente snapshots PUBLISHED são elegíveis. Metrics, dimensions, filters e orderBy são
resolvidos por metricKey/fieldKey, sempre usando AST, types, labels, dependencies e lineage da
inspection.

Filters exigem correspondência literal/type exata. Comparações ordenadas aceitam somente tipos
numéricos e temporais. DECIMAL precisa caber na precision/scale declarada sem cast, Number,
arredondamento ou truncamento. INTEGER não recebe precision física e NUMBER extremo continua
semanticamente válido. IS_NULL/IS_NOT_NULL aceitam todos os SemanticTypes.

Dependencies são expandidas para ResolvedField. Descriptions não são copiadas. `publishedAt`
permanece Date em uma nova instância, sem compartilhar referência com a inspection. O limit
semântico é preservado sem default ou safety cap. Não há I/O, source resolution, plano físico,
DuckDB, SQL, migration ou dependência nova. T-017 não foi iniciado.

## T-017 — Physical Expression Planning

Implementa duas boundaries separadas. `resolveAnalyticalSource` resolve metadata e material local
de uma DatasetVersion READY/CSV dentro do workspace. O path concreto permanece encapsulado em
material handle opaco. `planPhysicalQuery` é puro e transforma ResolvedSemanticQuery + fonte
autorizada em PhysicalQueryPlan fechado, sem PostgreSQL, filesystem, DuckDB ou SQL.

CSV é planejado como texto. Header, colunas, ordem, duplicatas, row shape e row count são globais;
somente fields usados recebem value conversion policy. inferred_type orienta lineage e
compatibilidade, sem revalidar valores de colunas não usadas.

DECIMAL parte do raw textual por TEXT_TO_EXACT_DECIMAL e nunca passa por DOUBLE materializado.
Arithmetic mista declara EXACT_DECIMAL/result type/overflow sem regra genérica
INTEGER-to-DECIMAL(38,0). NUMBER preserva texto e declara TEXT_TO_FINITE_DOUBLE; T-018/T-019 farão a
validação autoritativa sem JS Number. COUNT/COUNT_DISTINCT resultam BIGINT físico e INTEGER
semântico. Outputs mantêm dimensions antes de metrics, order usa outputIndex + NULLS LAST e limit
semântico não recebe safety cap.

Não houve migration ou dependência. T-018 não foi iniciado.

## T-018 — DuckDB Query Compiler

`compilePhysicalQuery` transforma o plano físico em `CompiledQuery` fechado sem executar DuckDB.
Somente o compiler produz SQL. Paths permanecem protegidos por material handle e
`MATERIAL_PATH`; literals são bound e physical names recebem quoting específico de identifier.

Cada execução exige conexão dedicada: valida header, materializa o CSV como VARCHAR em tabela
temporária, valida row count e somente os fields usados, executa validações de capacidade e então
disponibiliza a query analítica. O fechamento da conexão elimina a materialização. UTC é requisito
semântico; recursos, timeout, cancellation, safety cap e QueryResult permanecem T-019.

DuckDB 1.5.5 comprovou HUGEINT × DECIMAL(18,2) e SUM como DECIMAL(38,2), inclusive o ground truth
`2059.61`, sem DOUBLE. DECIMAL recebe validação lexical/envelope antes do cast; NUMBER rejeita
overflow, não-finitos e underflow para zero. Validation commands retornam boolean/counts e carregam
failure mappings controlados. Não houve migration ou dependência. T-019 não foi iniciado.

## Architecture boundary

```text
unknown
  ↓
parseSemanticQuery
  ↓
SemanticQueryV1
```

O T-016 combina `SemanticQueryV1` e `SemanticModelInspection` para produzir uma consulta resolvida.

## Out of scope do T-015

- resolução de metricKey ou fieldKey;
- compatibilidade entre fields, filters e order targets;
- source resolution ou paths;
- planejamento físico e política DuckDB;
- compilação ou execução;
- result contract ou explainability;
- endpoint, UI, Ask, dashboards ou IA;
- persistência, cache ou histórico de queries.
