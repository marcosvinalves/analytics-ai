# ADR-003 — PostgreSQL para metadados

Status: aceito no T-002, em 19/09/2026.

## Contexto e decisão

O monólito precisa de persistência relacional para os futuros metadados da aplicação.
Adotamos PostgreSQL, com `pg` como driver e uma configuração server-side baseada em `DATABASE_URL`.
Não há ORM, repositórios genéricos ou classes-base neste ticket.

O schema `app` reserva o espaço das futuras tabelas. T-002 não cria entidades de domínio.
`migration_metadata.history` guarda exclusivamente o histórico técnico de migrações.

O banco de metadados não é o motor de consultas analíticas. A futura execução de Semantic Query
terá seu próprio adaptador; DuckDB continua pendente do SP-01. Não usar `src/lib/db` como contrato
do motor analítico.

## Desenvolvimento local

Compose opcional usa `postgres:18.6-bookworm`, com volume nomeado, healthcheck e porta em loopback.
O volume é montado em `/var/lib/postgresql`, conforme a imagem PostgreSQL 18.
A linha 18 tem suporte previsto até novembro de 2030.
Também é possível usar uma instalação nativa ou outro servidor PostgreSQL acessível via `DATABASE_URL`.
A aplicação não chama Docker e não depende dele para executar.

Compose padroniza a versão e isola os dados, ao custo de Docker/virtualização.
A instalação nativa dispensa esse custo, mas exige provisionamento e manutenção manuais.
Atualizações da imagem devem ser deliberadas; a tag fixa não equivale a um digest imutável.

## Configuração e segurança

Credenciais vêm do ambiente ou de `.env.local`, ignorado pelo Git.
O exemplo versionado contém campos de credenciais vazios. Não usar `NEXT_PUBLIC_` para segredos.
O pool é criado sob demanda e limitado a cinco conexões por processo. Importá-lo não conecta ao banco.
A entrada da aplicação e o pool usam `server-only`.
O build e a página estática não precisam de banco ou credenciais.

O usuário de inicialização da imagem oficial é administrador local. Esse setup é apenas de desenvolvimento;
em implantação real, provisionar identidades e permissões adequadas para aplicação e migrações.
Conexões remotas devem usar os parâmetros TLS exigidos pelo provedor, sem desativar validação de certificado.

Referências: [PostgreSQL](https://www.postgresql.org/support/versioning/),
[imagem oficial](https://hub.docker.com/_/postgres),
[node-postgres](https://node-postgres.com/features/connecting).
