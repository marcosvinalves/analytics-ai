# ADR-020 — Query Execution & Typed Results

Status: aceito e implementado no T-019.

## Boundary

`executeCompiledQuery` recebe somente um `CompiledQuery` com provenance in-process do compiler.
O executor não gera, concatena, inspeciona nem reescreve SQL. Ele resolve o material autorizado,
configura uma execução DuckDB dedicada, consome o lifecycle compilado e produz um `QueryResult`
fechado. Não acessa PostgreSQL, AST semântico, storage por path público ou lifecycle de Dataset.

`CompiledQuery` não é formato de persistência, mensagem entre processos ou API para SQL externo.
A provenance privada evita executar objetos estruturais forjados sem criar token no DTO, hash de
SQL ou framework de capabilities.

## Material e integridade

O path existe apenas dentro de `withAnalyticalMaterial`. Todos os parâmetros `MATERIAL_PATH` da
execução recebem o mesmo path como `VARCHAR`; nunca há interpolação. `lstat` compara device, inode,
size e modified time com a identidade copiada do plan, exige arquivo regular e rejeita symlink.
A comparação ocorre antes do lifecycle e antes do retorno. Ausência, troca ou mudança resulta em
`SOURCE_INTEGRITY_FAILED`. Não há SHA-256 por query e nenhum detalhe do path/stat é público.

## Execução e sessão

Cada chamada cria uma instance `:memory:` e uma connection próprias, sem pool ou reuse. As opções
comprovadas no Windows x64, Node 22.23.2, DuckDB 1.5.5 e `@duckdb/node-api` 1.5.5-r.5 são:

- `threads=2`;
- `memory_limit=256MB`, reportado pelo engine como 244,1 MiB;
- `max_temp_directory_size=0B`;
- autoload e autoinstall de extensions desabilitados;
- timezone UTC;
- `errors_as_json=true`.

O lifecycle executa source validations, materialização TEMP, validations na ordem compilada e a
query. `finally` remove listener/timer e fecha connection e instance em todos os outcomes. O
executor não habilita extensões. A leitura autorizada do CSV exige acesso externo ao path bound;
não se afirma sandbox absoluto do engine.

## Timeout e cancelamento

O timeout fixo é 10 segundos. `AbortSignal` é opcional. O primeiro motivo entre timeout e abort é
registrado, chama `connection.interrupt()`, aguarda a operação ativa assentar e impede o próximo
statement. Abort anterior à chamada retorna `QUERY_CANCELLED` sem criar DuckDB. Não se usa
`Promise.race` como cancelamento.

O microspike interrompeu uma query ativa em cerca de 72 ms, recebeu `exception_type=INTERRUPT`,
aguardou a rejection e reutilizou a conexão imediatamente antes do close. Criação nativa da
instance ainda não oferece primitive própria de interrupção; se ela bloquear dentro do binding, o
timer só poderá ser observado quando o controle retornar ao JavaScript.

## Safety caps

O limit semântico permanece no SQL compilado e é independente dos caps de transporte. A query usa
`startStreamThenReadUntil` com alvo 501. O binding devolveu chunk de 2.048 linhas com `done=false`;
isso permite detectar `>500` e retornar `RESULT_LIMIT_EXCEEDED` sem resultado parcial e sem alterar
SQL. A técnica não afirma que DuckDB executa apenas 501 linhas: GROUP BY e ORDER BY podem
materializar internamente.

O payload público tem cap de 4 MiB. O accounting incremental inclui JSON UTF-8 de columns, rows,
cells, vírgulas e colchetes; para o contrato atual ele coincide com o tamanho serializado e, por
construção, não subestima. A execução para sem retornar parcial. Um chunk ou uma cell individual
pode ser alocada antes da detecção; memory limit, no-spill, timeout e interrupt complementam o cap.

## Resultado tipado

`QueryResult` contém columns e rows. Columns expõem apenas key lógica, label, role e SemanticType.
Não expõem SQL, path, physicalName, DuckDB type, alias `oN`, AST ou storage key. O mapeamento exige
quantidade de colunas, `outputIndex`, alias `oN`, physical type e precision/scale DECIMAL iguais ao
`CompiledQuery.outputs`; row width também deve coincidir.

`QueryValue` é tagged union. NULL usa `{ type: "NULL" }`. BIGINT/HUGEINT viram string diretamente
do bigint. DECIMAL usa unscaled bigint e scale e preserva zeros finais. DOUBLE é aceito apenas para
NUMBER finito e `-0` vira `"0"`. DATE, TIMESTAMP e TIMESTAMPTZ usam wrappers/parts/micros do binding,
sem JavaScript Date; DATETIME não tem timezone e INSTANT termina em `Z`, preservando até seis casas
de microssegundos. STRING não sofre trim/normalização e rejeita NUL. O resultado é reconstruído e
profundamente congelado.

## Validações e erros

Resultados de validation commands devem corresponder exatamente ao formato BOOLEAN ou aos
VIOLATION_COUNTS compilados. Counters são BIGINT não negativos. Falhas usam somente o failureCode
declarado pelo T-018.

Erros DuckDB são lidos com `JSON.parse` porque a sessão exige JSON. Somente `exception_type` é
considerado e precisa coincidir com o mapping do statement ativo. `exception_message` não é
interpretada nem exposta. Envelope desconhecido resulta em `QUERY_OPERATIONAL_FAILURE`.

Outcomes fechados: `SUCCESS`, os três códigos do compiler, integridade do source, caps de resultado,
timeout, cancelamento, inconsistência do compiled/result e falha operacional. Não há resultado
parcial, query history, cache, persistência, mutation do raw ou transição de DatasetVersion.

## Limites

O binding pode materializar operações analíticas internamente antes de entregar chunks. O limite
de 256 MiB vale por execução, portanto concorrência multiplica o teto do processo. Um único valor
pode ser temporariamente maior que o cap público. Deploy/bundling fora do ambiente já validado e
isolamento por processo permanecem decisões futuras.
