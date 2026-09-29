# ADR-016 — Semantic Query Contract

Status: aceito no Architecture Gate do EPIC-03 e implementado no T-015.

## Fronteira do contrato

`SemanticQueryV1` representa uma consulta semântica estruturada, versionada e independente de
PostgreSQL, DuckDB, SQL e storage. O parser transforma `unknown` em um novo objeto de domínio ou
retorna `INVALID_QUERY` com issues seguras e determinísticas. Ele não consulta
`SemanticModelInspection` e não decide se keys existem ou se uma operação é semanticamente ou
fisicamente executável; essas responsabilidades começam no T-016.

A V1 aceita de uma a quatro `metricKey`, até três `fieldKey` como dimensions, oito filters com AND
implícito, três critérios de order e um limit semântico opcional entre 1 e 1000. Duplicatas de
metrics, dimensions e order targets são inválidas. UUIDs seguem a convenção sintática existente e
são normalizados para lowercase. Exact-key validation em todos os níveis impede SQL, nomes físicos
e propriedades não previstas de entrarem no contrato.

## Literals

`SemanticLiteral` é uma união discriminada explícita. INTEGER, DECIMAL e NUMBER são strings
canônicas: nenhum deles passa por JavaScript `number`. INTEGER e DECIMAL têm até 38 dígitos de
precision; NUMBER tem gramática decimal/exponencial fechada e até 64 caracteres, mas T-015 não
testa range físico. STRING preserva Unicode, aceita vazio, rejeita NUL e tem limite de 4096 bytes.
BOOLEAN usa boolean real.

DATE usa calendário ISO `YYYY-MM-DD`. DATETIME exige data e hora sem timezone e aceita até seis
casas fracionárias. INSTANT V1 aceita somente UTC explícito com `Z`. Não existe literal NULL;
`IS_NULL` e `IS_NOT_NULL` expressam essa intenção. A capacidade de conversão pertence ao futuro
planejamento físico.

## Canonicalização e imutabilidade

O parser reconstrói e congela profundamente o resultado, normaliza keys, preserva a ordem das
listas e omite arrays opcionais vazios. Uma serialização própria por construção, com propriedades
em ordem fixa, limita a representação a 16 KiB UTF-8. `canonicalJson` e `canonicalBytes` são apenas
metadata do resultado do parser para size enforcement, determinismo e testes. Eles não pertencem a
`SemanticQueryV1`, não definem identidade, não são persistidos e não criam hash, cache ou histórico.

`limit` presente tem significado semântico. Sua ausência continua significando uma consulta sem
top-N. Safety result caps pertencem à execução futura e não são inseridos pelo parser.

## Defesa estrutural

Somente objetos simples com propriedades próprias, enumeráveis e de dados são aceitos. Símbolos,
accessors, protótipos customizados e propriedades desconhecidas falham de forma segura. O parser
retorna no máximo 64 issues, com paths controlados e mensagens fixas que não reproduzem payloads.
Nenhuma migration ou dependência foi adicionada.
