# ADR-019 — DuckDB Query Compiler

Status: aceito e implementado no T-018.

## Boundary e ownership

`compilePhysicalQuery` transforma um `PhysicalQueryPlan` fechado em `CompiledQuery` sem executar
DuckDB, abrir arquivos ou consultar PostgreSQL. Todo SQL analítico nasce no compiler. Plan, source
resolver e futuro executor não aceitam nem montam fragmentos SQL livres.

O compiler recebe somente o plan. O path concreto não entra na linguagem física: `CompiledQuery`
preserva o `AnalyticalMaterialHandle`, copia a `materialIdentity` já resolvida no T-017 e representa
o uso do path com um parâmetro `MATERIAL_PATH`. O T-019 resolve o handle por
`withAnalyticalMaterial`, faz binding como `VARCHAR` e compara a identidade antes e depois da
execução. O compiler não recalcula a identidade.

O objeto compilado também é registrado em um `WeakSet` privado. Essa provenance torna
`CompiledQuery` uma capability in-process na Technical Alpha: somente o objeto produzido por
`compilePhysicalQuery` pode ser executado. Não é contrato serializável nem permite reexecução em
outro processo; objetos estruturais reconstruídos são rejeitados.

## Contrato compilado e lifecycle

`CompiledQuery` contém requisitos semânticos de sessão, validação do header, materialização,
validações pós-materialização, query e output descriptors. Cada execução requer uma conexão
DuckDB dedicada. A tabela temporária `__t018_source` vive somente nessa conexão e o cleanup é o
fechamento da conexão. Assim, nomes determinísticos não permitem observar materialização de uma
execução anterior.

Timezone UTC é requisito semântico para `TIMESTAMPTZ`. Threads, memória, spill, timeout,
cancelamento e safety result cap pertencem ao T-019.

## SQL seguro

Identifiers usam uma função DuckDB-specific que envolve o valor em aspas duplas e duplica aspas
internas. Ela nunca é usada para literals. Aliases de output são somente `o0`, `o1`, etc. GROUP BY
e ORDER BY usam posições inteiras reconstruídas pelo compiler.

Valores externos usam parâmetros. INTEGER, DECIMAL, NUMBER e temporais permanecem texto na
boundary JavaScript; não passam por JavaScript Number ou Date. Precision, scale, posições e
aliases pertencem à gramática fechada e são revalidados antes de entrar no SQL.

## CSV textual

O micro-spike em DuckDB 1.5.5 comprovou que `header=false, skip=1` pula um registro de header e
preserva quoted headers, delimitadores e aspas escapadas, campos multiline, BOM, empty fields,
quoted empty fields e strict row shape. A implementação usa nomes internos `c0...cN` declarados
explicitamente como `VARCHAR`, sem auto inference, e projeta cada coluna para seu physicalName
quoted. O header é lido separadamente como `h0...hN`.

Validação global cobre header, quantidade e ordem de colunas, duplicatas, row shape estrito e row
count esperado. Somente `sourceFields` usados recebem validação de conteúdo.

## Conversões

Todas as conversões preservam NULL. BOOLEAN aceita apenas `true` e `false`. INTEGER usa gramática
inteira fechada e `HUGEINT`. NUMBER exige forma numérica, DOUBLE finito e rejeita underflow de
coeficiente matematicamente não zero para zero. DATE, DATETIME e INSTANT combinam contrato lexical
com parser do engine; DATETIME não recebe timezone e INSTANT aceita somente UTC `Z`. STRING não é
trimmed ou normalizada e rejeita NUL. UUID para STRING valida somente o field usado e preserva o
texto original.

`TEXT_TO_EXACT_DECIMAL(p,s)` valida gramática, scale, integer digits e `TRY_CAST` antes do cast
analítico. Scale excedente ou formato inválido é `SOURCE_VALUE_INVALID`; envelope/range é
`NUMERIC_OVERFLOW`. Não existe ROUND, truncation, DOUBLE intermediário ou redução silenciosa de
scale.

## Aritmética comprovada

O micro-spike em Windows x64 com Node 22.23.2, `@duckdb/node-api` 1.5.5-r.5 e DuckDB
1.5.5 comprovou:

- HUGEINT com DECIMAL(18,2), em ADD, SUBTRACT e MULTIPLY, resulta em DECIMAL(38,2);
- o produto `2 × 10.25` permanece `20.50`;
- SUM(HUGEINT) retorna HUGEINT;
- SUM(DECIMAL(18,2)) retorna DECIMAL(38,2);
- SUM(DOUBLE) retorna DOUBLE;
- COUNT e COUNT DISTINCT retornam BIGINT;
- quantity × unit price e SUM, partindo do texto, retornam DECIMAL(38,2) e `2059.61` sem DOUBLE.

Por isso INTEGER com DECIMAL usa a operação direta comprovada e o result type físico do plan. Não
há cast genérico INTEGER para DECIMAL(38,0). Operações entre dois DECIMAL ampliam os operands de
forma exata para evitar a largura reduzida que DuckDB pode escolher para DECIMAL de até 18 dígitos,
e normalizam somente para o result type autoritativo do plan.

## Validação e erros

Validation commands carregam kind, purpose, statement, formato esperado e mapeamento de checks
para códigos controlados. Resultados são boolean ou violation counts e nunca incluem valores raw.

Com `errors_as_json=true`, DuckDB 1.5.5 forneceu `exception_type` estruturado. Statements
compiler-owned mapeiam `Invalid Input` durante header/materialização estrita para
`SOURCE_SCHEMA_MISMATCH`, e `Out of Range` durante a query para `NUMERIC_OVERFLOW`. O futuro
executor poderá ler esse discriminator JSON; não deverá fazer substring, regex ou interpretar o
texto livre de `exception_message`. Tipos não mapeados permanecem falha operacional.

Resultados DOUBLE recebem uma validation query equivalente que rejeita Infinity/NaN antes de um
QueryResult futuro. Essa repetição pequena e limitada evita esconder não-finitos e não cria um
executor no T-018.

## Visibilidade e escopo

SQL existe apenas no contrato interno. Não pertence a DTO público, erro público, log normal ou
explainability. O compilador é determinístico, reconstrói e congela seu output e não altera o plan.

T-018 não implementa PostgreSQL, endpoint ou UI. A execução, QueryResult, safety cap, timeout e
cancelamento são definidos pelo T-019. Não adiciona migration ou dependência.
