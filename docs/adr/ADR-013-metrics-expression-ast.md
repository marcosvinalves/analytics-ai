# ADR-013 — Metrics e Expression AST

Status: aceito e implementado no T-012.

## Metric e identidade

Metric pertence a uma SemanticModelRevision. `id` identifica a linha naquela revisão;
`metric_key` identifica logicamente a métrica; `name` é um identificador técnico editável. O writer
gera UUIDv4 para id e metric_key. Rename e edição da expressão preservam ambas as identidades.
T-012 não implementa carry-forward automático entre revisões.

## Persistência do AST

`metrics.expression` guarda um AST v1 declarativo em JSONB. Não contém SQL, nomes físicos,
funções arbitrárias, plano ou expressão de um engine. A raiz é sempre SUM, COUNT ou
COUNT_DISTINCT. Nós escalares são field, literal ou ADD/SUBTRACT/MULTIPLY. Aggregate não pertence
ao tipo escalar, portanto não pode ser aninhado.

JSONB é a fonte da expressão. `metric_field_references` é apenas a projeção relacional do conjunto
distinto de field_key. FKs compostas garantem que Metric e SemanticField pertencem à mesma revisão
e impedem remoção órfã. O writer mantém JSONB e projeção atomicamente. Não há trigger que interprete
o documento.

## Tipos exatos

Literals INTEGER e DECIMAL usam texto canônico e nunca JavaScript Number. ADD/SUBTRACT de dois
DECIMAL usam `max(integerDigits) + max(scale) + 1`; MULTIPLY usa a soma de precision e scale.
Resultados acima de DECIMAL(38) são inválidos e scale nunca é reduzida silenciosamente.

SemanticType INTEGER não declara precision. Tratá-lo como DECIMAL(38,0) causaria overflow
artificial em expressões centrais como quantity × unit_price. O contrato de promoção entre um
INTEGER de field e DECIMAL(p,s) é DECIMAL(38,s): preserva a scale e usa o maior envelope decimal
permitido, sem atribuir uma largura fictícia ao INTEGER e sem converter para NUMBER. Um valor real
fora desse envelope deverá causar overflow explícito no futuro executor; T-012 não executa casts
nem dados. Quando o INTEGER é um literal, sua quantidade canônica de dígitos é conhecida e pode
participar das fórmulas DECIMAL diretamente.

SUM(INTEGER) resulta INTEGER; SUM(DECIMAL(p,s)) resulta DECIMAL(38,s); SUM(NUMBER) resulta NUMBER.
COUNT e COUNT_DISTINCT resultam INTEGER de cardinalidade não negativa. Esse INTEGER descreve o
resultado semântico da contagem e não afirma que domínio ou representação sejam idênticos aos de
qualquer SemanticField INTEGER físico. Nenhuma metadata adicional é persistida para isso.

Compatibilidade e inferência semântica continuam sem prometer uma estratégia de execução. O futuro
compiler deverá implementar ou rejeitar cada expressão de forma explícita.

## Limites e serialização

O domínio normaliza o AST, serializa a forma canônica com JSON.stringify e mede os bytes UTF-8
antes da persistência. O limite primário é 16 KiB, com profundidade 8 e 64 nós. O CHECK PostgreSQL
usa 17 KiB: os 1024 bytes adicionais acomodam somente os espaços que `jsonb::text` pode acrescentar
à mesma estrutura. Assim, a serialização defensiva do banco não rejeita um documento aceito no
limite canônico da aplicação.

## Lifecycle e concorrência

Create, update e remove bloqueiam a SemanticModelRevision e aceitam apenas DRAFT. O mesmo lock é
usado por alterações de SemanticField. Remover field referenciado retorna FIELD_IN_USE. Alterar o
semantic_type revalida as Metrics afetadas e é bloqueado se alguma ficar inválida. A proteção
completa de conteúdo PUBLISHED/ARCHIVED e o workflow de publicação continuam no T-013.

SUM ignora NULL e retorna NULL sem valores não-NULL. COUNT(expression) conta valores não-NULL.
COUNT_DISTINCT conta valores distintos não-NULL. Ambos retornam zero sem valores. Operações
binárias propagam NULL. T-012 apenas define essa semântica; não executa DuckDB ou consultas.
