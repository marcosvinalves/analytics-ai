# ADR-014 — Validação e publicação semântica

Status: aceito e implementado no T-013.

## Snapshot publicável

Uma SemanticModelRevision somente pode ser publicada quando pertence ao workspace solicitado, sua
DatasetVersion pertence ao mesmo Dataset do SemanticModel e está `READY`, e o snapshot possui ao
menos um SemanticField e uma Metric. Cada field precisa de lineage físico íntegro, tipo semântico
válido e compatibilidade física admissível. Cada metric precisa de AST v1 válido, inferência de tipo
válida e projeção `metric_field_references` exatamente igual ao conjunto de `field_key` do AST.

A validação de conteúdo é pura, determinística e independente do status. A API pública de validação
aplica separadamente a elegibilidade `DRAFT`, é read-only e retorna issues sem severity. Essa
separação permite que uma leitura futura inspecione a consistência de snapshots publicados sem
afrouxar o lifecycle de publicação.

## Lifecycle e substituição

As únicas transições são `DRAFT → PUBLISHED` e `PUBLISHED → ARCHIVED`. Publicar uma nova revisão
arquiva a revisão publicada anterior do mesmo SemanticModel na mesma transação. Não existe API
pública de arquivamento nem criação automática do próximo draft.

`published_at` registra o instante original da publicação. A transição para `ARCHIVED` preserva esse
valor. Uma chamada repetida para a mesma revisão publicada retorna `ALREADY_PUBLISHED`; uma revisão
arquivada não pode ser republicada.

## Concorrência e atomicidade

A publicação bloqueia primeiro o SemanticModel e depois a SemanticModelRevision. O lock do modelo
serializa publicações de revisões diferentes; o lock da revisão é o mesmo boundary usado pelos
writers de fields e metrics. A validação e as duas mudanças de status ocorrem dentro da transação.
Em COMMIT incerto, a operação consulta novamente a revisão; nunca repete a transição às cegas.

Os triggers de conteúdo bloqueiam a revisão proprietária com `FOR SHARE` e aceitam DML apenas em
`DRAFT`. Em PostgreSQL 18.6 foi validado que uma transação que já possui `FOR UPDATE` na mesma
revisão pode criar, atualizar e remover SemanticField e Metric, com COMMIT ou ROLLBACK, sem
deadlock. Também foram validadas a serialização entre publicação e mutações e duas publicações
concorrentes.

## Defesa no PostgreSQL

O guard de lifecycle permite somente criação em `DRAFT`, publicação e arquivamento. Em
`PUBLISHED → ARCHIVED`, id, semantic_model_id, dataset_version_id, revision_number, label,
description, published_at e created_at permanecem iguais. `updated_at` muda somente pelo trigger de
manutenção de timestamp. Qualquer atualização de negócio mantendo `PUBLISHED` ou `ARCHIVED` é
rejeitada; uma revisão arquivada não aceita atualização ou remoção.

Triggers específicos protegem INSERT, UPDATE e DELETE em `semantic_fields`, `metrics` e
`metric_field_references` quando a revisão não é `DRAFT`. Constraints e FKs continuam responsáveis
pelas invariantes estruturais; a validação de domínio decide se o snapshot está pronto para
publicação. Os triggers não interpretam AST nem executam workflow.

T-013 não executa DuckDB, não compila SQL, não avalia metrics e não implementa T-014.
