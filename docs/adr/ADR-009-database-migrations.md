# ADR-009 — Migrações explícitas dos metadados

Status: aceito no T-002, em 19/09/2026.

## Decisão

Usar `node-pg-migrate` com arquivos SQL versionados em `migrations/` e histórico em
`migration_metadata.history`. O migrador cria o schema técnico; a primeira migração cria `app` vazio.
O provisionamento cria o database; as migrações criam os objetos dentro dele.

`npm run db:migrate` aplica somente migrações pendentes, em ordem, com transação e advisory lock.
Reexecutar o comando não reaplica uma migração registrada. A primeira migração usa `CREATE SCHEMA app`
sem `IF NOT EXISTS`, para detectar um schema preexistente fora do histórico.
Não editar migrações já aplicadas; acrescentar um novo arquivo com prefixo numérico crescente.
Usar nomes de objetos qualificados por schema nas próximas migrações.

Não há execução automática em build, inicialização, servidor de desenvolvimento ou requisições.
O script oferece apenas avanço. O SQL inicial possui reversão com `DROP SCHEMA app RESTRICT`,
sem `CASCADE`; qualquer rollback futuro exige um fluxo explícito e revisão.
Não há comando de reset destrutivo neste ticket.

O runner suprime SQL e erros brutos nos logs; os scripts retornam códigos/mensagens seguros e exit code não zero
em caso de falha. Timeouts limitam conexão e execução. Isso reduz detalhes de diagnóstico; ao investigar,
consultar logs do servidor com acesso apropriado, preservando segredos.

## Alternativas

- Drizzle: oferece schemas TypeScript e geração de SQL, mas adiciona a escolha de ORM/modelagem.
- Prisma: integra modelos, cliente e migrações, com escopo maior que a fundação atual.
- Runner próprio: exigiria implementar histórico, concorrência e tratamento de falhas.

`pg` com `node-pg-migrate` mantém o SQL explícito sem implementar esses mecanismos.
A contrapartida é escrever as migrações manualmente e revisar seu SQL.
Essas ferramentas se destinam somente aos metadados, não ao futuro motor analítico.

## Scripts sem novas dependências de execução TypeScript/ambiente

Não adicionamos `tsx`: Node 22.23.2 executa os scripts TypeScript por remoção nativa de tipos.
Usamos imports relativos com extensão `.ts`, tipos apagáveis e nenhum alias de `tsconfig` nos scripts.
`tsc --noEmit` continua responsável pela checagem dos tipos.

Não adicionamos `@next/env`: `node --env-file-if-exists=.env.local` carrega o único arquivo local
documentado para comandos administrativos, mantendo precedência das variáveis já exportadas.
Isso não pretende reproduzir toda a hierarquia `.env*` do Next.js. Use `.env.local` ou ambiente exportado
para a conexão compartilhada entre aplicação e comandos. O parser nativo não expande `${VAR}`:
preencha a URL completa e escape usuário/senha como componentes de URL.

`db:check` usa `--conditions=react-server` para importar o módulo de banco marcado com `server-only`
em um processo administrativo Node, fora do bundler Next.js.

## Verificação

Testes unitários executam sem banco. Integração é um comando separado que exige `TEST_DATABASE_URL`,
sem fallback e com database dedicado terminado em `_test`.
A preparação global recusa tabelas ou schemas da aplicação já existentes e aplica as três migrações
em um database inicialmente vazio. Os testes verificam conectividade, reaplicação sem mudanças e
as cinco tabelas do T-003 e as colunas aditivas do T-004. Um teste de rollback reverte T-004 e T-003
no database descartável, verifica a fundação vazia T-002 e reaplica ambas, preservando seu histórico inicial.
Fixtures de schema usam transações revertidas; os testes de upload removem seus próprios registros.
Não há remoção de objetos preexistentes nem reset do banco de desenvolvimento.
O database fica disponível para inspeção e precisa ser recriado explicitamente antes de outra execução completa.

Referências: [Node TypeScript](https://nodejs.org/docs/latest-v22.x/api/typescript.html),
[node-pg-migrate](https://salsita.github.io/node-pg-migrate/).
