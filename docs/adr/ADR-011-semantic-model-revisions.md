# ADR-011 — SemanticModel e revisões

Status: aceito no Architecture Gate do EPIC-02 e implementado no T-010.

## Identidade e ownership

`SemanticModel` é a identidade semântica estável de um `Dataset`. Na Technical Alpha existe no
máximo um modelo por dataset. `SemanticModelRevision` é um snapshot ligado a uma
`DatasetVersion` específica.

A revisão armazena somente `semantic_model_id` e `dataset_version_id`. Não duplica `dataset_id`.
A operação interna de criação valida, na mesma transação, que modelo e versão pertencem ao mesmo
Dataset. Essa escolha preserva o modelo mínimo e segue o padrão do ADR-010. Escrita SQL que contorne
a operação da aplicação também contorna esse invariant e não é uma interface suportada.

O ownership continua derivado pela cadeia:

```text
SemanticModel → Dataset → Workspace → Organization
```

As FKs usam `ON DELETE RESTRICT ON UPDATE RESTRICT`. UUIDv4 e `timestamptz` seguem o ADR-010.

## Revisões e lifecycle

O vocabulário persistido é `DRAFT`, `PUBLISHED` e `ARCHIVED`. T-010 cria somente `DRAFT`.
Publicação, arquivamento, validação integral e proteção completa de conteúdo pertencem ao T-013.

Existe no máximo um draft e uma revisão publicada por modelo. `revision_number` é positivo e único
por modelo. O escritor bloqueia a linha do SemanticModel antes de calcular `MAX(revision_number) + 1`;
a constraint única é a defesa final.

`published_at` representa o instante em que a revisão foi originalmente publicada. Quando T-013
implementar `PUBLISHED → ARCHIVED`, esse valor deverá ser preservado. T-010 não cria `archived_at`.

Drafts são conceitualmente editáveis. No T-010, a igualdade de dataset, versão, modelName, label e
description serve somente para tornar `createSemanticModelDraft` idempotente. Ela não estabelece
imutabilidade de drafts. Revisões `PUBLISHED` e `ARCHIVED` serão snapshots imutáveis no T-013.

## Criação transacional

A criação exige DatasetVersion `READY`, bloqueia Dataset e DatasetVersion para leitura estável,
insere ou resolve o único SemanticModel e então bloqueia o modelo. Pedidos concorrentes para o
primeiro modelo são reconciliados pela unicidade de `dataset_id` e pelo lock subsequente. Um pedido
idêntico retorna o draft existente; diferenças retornam conflito e nunca sobrescrevem dados.

Falha antes de COMMIT causa rollback. Falha de COMMIT é reconciliada por nova conexão; se o estado
exato não puder ser provado, o resultado permanece desconhecido e não há retry automático cego.

## Precisão semântica futura

Declarar um futuro SemanticField como `DECIMAL` definirá intenção semântica, precision e scale, mas
não definirá sozinho a estratégia física de conversão. Converter um `DOUBLE` já materializado para
`DECIMAL` não garante recuperar o decimal original. O T-009 preservou precisão relendo a
representação textual original do CSV antes do cast decimal. O compilador do EPIC-03 deverá tratar
essa distinção explicitamente. T-010 não implementa fields, casts, compilação ou execução.
