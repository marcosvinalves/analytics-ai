# ADR-012 — Semantic Fields e Type System

Status: aceito e implementado no T-011.

## SemanticField e identidade

SemanticField pertence a uma SemanticModelRevision e mapeia explicitamente uma DatasetColumn da
DatasetVersion vinculada à revisão. `id` identifica a linha do snapshot. `field_key` identifica o
conceito lógico e poderá ser preservado explicitamente entre revisões. `name` é um identificador
técnico legível, não a identidade referencial. `dataset_column_id` é somente o vínculo físico.

O primeiro field recebe UUIDv4 controlado pelo servidor. Renomear ou editar um draft preserva a
key. Um significado novo recebe uma key nova. T-011 não implementa cloning, propagação ou matching
automático entre versões.

## Integridade física

`semantic_fields.dataset_version_id` é redundância controlada. Duas FKs compostas garantem que a
revisão e a coluna física pertencem à mesma DatasetVersion. Essa garantia central de lineage fica
no PostgreSQL sem trigger. O custo aceito é um UUID por field e constraints únicas auxiliares em
SemanticModelRevision e DatasetColumn.

Existe no máximo um field para cada coluna física por revisão. Field key e name também são únicos
dentro da revisão. Todas as FKs usam DELETE/UPDATE RESTRICT.

## Type System

Os tipos semânticos iniciais são STRING, BOOLEAN, INTEGER, DECIMAL, NUMBER, DATE, DATETIME e
INSTANT. DECIMAL exige precision entre 1 e 38 e scale entre 0 e precision. Outros tipos não aceitam
precision ou scale. MONEY/CURRENCY não existe no P0.

`TypeCompatibility` responde se uma interpretação semântica é admissível. Ele não afirma que já
existe uma estratégia de execução capaz de realizar a conversão. SAFE representa uma interpretação
direta. EXPLICIT exige intenção expressa. INVALID rejeita o mapeamento.

Essa distinção é essencial em DOUBLE → DECIMAL: a declaração registra intenção, precision e scale,
mas converter um DOUBLE já materializado não recupera necessariamente o decimal original. T-009
foi exato porque releu o texto original do CSV antes do cast. T-011 não lê dados, não faz cast e não
executa DuckDB. O compilador do EPIC-03 deverá decidir como cumprir a intenção ou rejeitar a
execução.

DATE → DATETIME é INVALID no T-011. Não há política implícita de meia-noite. Timestamp sem timezone
é DATETIME; timestamp com timezone é INSTANT.

## Escrita e lifecycle

Create, update e remove bloqueiam a SemanticModelRevision e aceitam somente DRAFT. Update preserva
id e field_key. Remove é hard delete de conteúdo ainda não publicado. A proteção completa de
PUBLISHED/ARCHIVED continua pertencendo ao T-013.

Toda operação é escopada por workspace, o que ainda não representa autenticação ou autorização.
Workspace incorreto e recursos fora do escopo retornam NOT_FOUND. Não há endpoint ou UI no T-011.
