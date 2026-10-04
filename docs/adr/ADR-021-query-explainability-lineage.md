# ADR-021 — Query Explainability & Lineage

Status: aceito e implementado no T-020.

## Boundary semântica

`buildQueryExplanation` é uma função pura e síncrona que combina `ResolvedSemanticQuery` e
`QueryResult`. A primeira é a fonte autoritativa de significado; a segunda participa somente da
verificação de columns, ordem, tipos e shape. T-017, T-018 e T-019 já validam as transições para
plano físico, compiled query e resultado, portanto a explanation não recebe nem reinspeciona esses
artefatos.

Não existe execution receipt, ID, hash, assinatura ou provenance adicional. T-021 será responsável
por manter a correlação causal in-process entre consulta resolvida e resultado. T-020 não importa o
`WeakSet` do compiler, não executa SQL e não acessa PostgreSQL, DuckDB, filesystem, storage, rede,
clock ou AI.

## QueryExplanation V1

O DTO versionado contém model, revision publicada, Dataset, DatasetVersion, métricas, dimensões,
filtros, ordenação, limit semântico opcional, outputs e `resultShape`. IDs de model, revision,
Dataset e DatasetVersion são mantidos porque identificam exatamente o snapshot semântico e os
dados usados. `publishedAt` é convertido para ISO UTC determinístico. Não há resolução de latest.

`resultShape` contém somente `rowCount` e `columnCount`. Rows e seus valores não são copiados. O
limit semântico é preservado apenas quando existe; caps de 500 rows e 4 MiB do executor não fazem
parte da explicação.

## Métricas e expressões

Cada métrica expõe metricKey, name, label, result type, semântica numérica, expressão e
dependencies. A expressão usa DTO próprio com AGGREGATE, FIELD, LITERAL e BINARY. Operadores são
SUM, COUNT, COUNT_DISTINCT, ADD, SUBTRACT e MULTIPLY. COUNT(*) não existe. FIELD contém somente
fieldKey e label; LITERAL preserva tipo semântico e valor textual.

O builder não reutiliza o MetricExpression como contrato público. Ele traduz e clona o AST
semântico, confere suas referências contra `ResolvedMetric.dependencies` e reutiliza a inferência
semântica do T-012 para validar result type. Dependencies e dimensions expõem somente fieldKey,
name, label e SemanticType. Physical lineage permanece interna.

INTEGER e DECIMAL são `EXACT`; NUMBER é `APPROXIMATE`. Essa classificação deriva somente do
SemanticType. Não consulta tipos físicos nem chama DECIMAL de moeda.

## Filtros e ordenação

Filtros mantêm ordem, field semântico, operador e literal tipado. O bloco declara explicitamente
`combination: AND`. São suportados EQ, NEQ, GT, GTE, LT, LTE, IN, IS_NULL e IS_NOT_NULL. IN
preserva a ordem dos valores. Nenhum filtro é transformado em SQL.

No Alpha, os valores completos dos filtros permanecem no DTO. Por isso **QueryExplanation não é
safe-to-log** e não deve ser enviada automaticamente a logs, telemetria ou provedores externos.
Uma futura boundary externa poderá aplicar redaction; T-020 não cria framework de privacidade.

OrderBy expõe somente role, key, label, direction e `nulls: LAST`. Essa política observável já faz
parte do pipeline semântico aprovado. Não há outputIndex nem alias DuckDB.

## Outputs e consistência

Outputs esperados são reconstruídos de `ResolvedSemanticQuery`: dimensions primeiro e metrics
depois. Para cada output, a explanation contém key, label, role, SemanticType e, quando numérico,
EXACT ou APPROXIMATE.

`QueryResult.columns` precisa coincidir exatamente em quantidade, ordem, key, label, role e tipo.
Cada row deve ter a largura esperada. Tags não nulas de `QueryValue` devem corresponder ao
SemanticType; NULL é aceito em qualquer output. Valores analíticos não são validados nem copiados.

Inconsistências semânticas ou de resultado retornam `INCONSISTENT_QUERY_ARTIFACTS`. Até 16 issues
determinísticas usam somente os códigos `SEMANTIC_MISMATCH`, `RESULT_MISMATCH` e
`ISSUE_LIMIT_REACHED`, paths controlados e mensagens fixas. Não existe NOT_FOUND nem explanation
parcial.

## Imutabilidade e segurança

O output é totalmente reconstruído e profundamente congelado. SemanticTypes, arrays, literals e
expressões não compartilham referências mutáveis com os inputs. A função não muta consulta ou
resultado e os mesmos inputs produzem o mesmo objeto por valor.

O DTO não contém SQL, physicalName, physical type, cast, conversion policy, DuckDB alias, source
path, material handle/identity, storage namespace/key, temporary table, exception message ou rows
do resultado. Ele pode alimentar uma UI ou futura verbalização por AI, mas metadata semântica
continua sendo a única fonte de verdade.
