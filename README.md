# Analytics AI

Fundação da Technical Alpha (T-001 a T-003): Next.js App Router, React, TypeScript e PostgreSQL para metadados.
A aplicação contém somente uma página estática. Os módulos são diretórios reservados, sem comportamento de domínio.

## Requisitos

- Node.js **22.23.2 LTS**, registrado em `.nvmrc`.
- npm **11.12.1**, usado na instalação e validação.

A linha Node 22 está em Maintenance LTS, com suporte até 30/04/2027.
Ela satisfaz o mínimo do Next.js 16 (`>=20.9`) e do Vitest 5 (`^22.12`).
A escolha independe do Node instalado globalmente na máquina.
TypeScript 5.9.3 mantém a configuração na linha 5, compatível com o tooling selecionado.

Referências: [ciclo de suporte do Node](https://github.com/nodejs/Release),
[instalação do Next.js](https://nextjs.org/docs/app/getting-started/installation).
As versões exatas estão em `package.json` e `package-lock.json`.

Aviso de tooling: ESLint 9.39.5 está fora de suporte, mas o plugin React usado
por `eslint-config-next` ainda declara suporte somente até ESLint 9.
Reavaliar a atualização quando essa cadeia suportar ESLint 10.

## Executar localmente

Ative a versão de `.nvmrc` com seu gerenciador de Node. No nvm-windows:

```powershell
nvm install 22.23.2
nvm use 22.23.2
npm ci
npm run dev
```

Abra <http://localhost:3000>. A página estática e o build não exigem banco.
Operações de metadados exigem `DATABASE_URL`. `.env.local` é ignorado pelo Git.
Nunca coloque segredos em variáveis `NEXT_PUBLIC_`.

## PostgreSQL e migrações (T-002)

PostgreSQL guarda metadados da aplicação. O futuro motor de consultas analíticas tem arquitetura
independente e continua pendente do SP-01. T-002 cria a fundação; T-003 adiciona somente o schema de metadados.

Copie `.env.example` para `.env.local` e preencha `DATABASE_URL` com a URL completa do database.
Use `postgresql://<usuario>:<senha-escapada>@<host>:<porta>/<database>`; escape os componentes
de usuário/senha com percent-encoding. Não faça referência a outras variáveis dentro da URL.
Variáveis exportadas no processo têm precedência sobre o arquivo local.
Os scripts carregam somente `.env.local`, não toda a hierarquia `.env*` do Next.js.

O database deve existir antes das migrações. Os comandos não criam databases ou usuários.

### Opção A: Docker Compose

Instale/inicie Docker com Compose e preencha também `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` e `POSTGRES_PORT` no arquivo local. A URL deve usar os mesmos valores,
host `127.0.0.1` e a porta publicada. Não há senha padrão.

```powershell
Copy-Item .env.example .env.local
# Preencha o arquivo local antes de iniciar o banco.
docker compose --env-file .env.local up -d --wait
npm run db:check
npm run db:migrate
```

Compose usa `postgres:18.6-bookworm`, healthcheck e volume nomeado persistente.
A porta fica restrita a `127.0.0.1`; a aplicação roda normalmente no host.
Se 5432 já estiver ocupada, escolha outra `POSTGRES_PORT` e ajuste a URL.
Para parar preservando os dados: `docker compose --env-file .env.local down`.
As variáveis de inicialização da imagem só criam usuário/database em volume vazio;
alterar a senha no arquivo não altera a senha de um cluster já inicializado.
Não use o usuário administrador local deste exemplo como modelo de permissões de produção.

### Opção B: PostgreSQL nativo ou existente

Provisione um database vazio dedicado e um usuário com permissão para conectar e criar schemas.
Por exemplo, com as ferramentas PostgreSQL e um usuário previamente provisionado:

```powershell
createdb -h 127.0.0.1 -p 5432 -U <usuario> -W -O <usuario> analytics_metadata
```

A senha é solicitada interativamente. Configure `DATABASE_URL`, execute `npm run db:check`
e `npm run db:migrate`. Não são necessárias variáveis `POSTGRES_*` ou Docker nesse caminho.
No Windows, se as ferramentas não estiverem no PATH, use o diretório `bin` da instalação.
Em servidores remotos, configure TLS conforme o provedor, sem desativar validação do certificado.

### Resultado e manutenção

```text
database de metadados
├── app
│   ├── organizations
│   ├── workspaces
│   ├── datasets
│   ├── dataset_versions
│   └── dataset_columns
└── migration_metadata
    └── history                 (controle técnico de migrações)
```

`npm run db:migrate` aplica SQL de `migrations/` com transação, ordem e advisory lock.
Uma segunda execução deve informar zero migrações aplicadas. Não altera o build ou o startup.
Migrações novas recebem prefixo numérico crescente; não modifique as já aplicadas.
Em um banco vazio são aplicadas duas migrações; em um banco T-002, somente a nova migração T-003.
Não há reset automático, seeds, API ou UI para manipular essas tabelas.
O schema `public` padrão do PostgreSQL permanece sem tabelas da aplicação.

O [ADR-010](docs/adr/ADR-010-core-metadata-schema.md) documenta as colunas, constraints e índices.
IDs usam UUIDv4 gerado no banco; timestamps usam `timestamptz`.
As quatro FKs usam `ON DELETE RESTRICT ON UPDATE RESTRICT`.
O trigger `updated_at` mantém apenas timestamps: não implementa versionamento, autorização ou imutabilidade.
`source_type` aceita texto não vazio; tipos suportados serão validados pela aplicação.
As referências de storage nunca devem conter bytes de arquivos, credenciais ou URLs assinadas.

Os módulos de metadados ficam em `src/lib/db`; a aplicação server-side importa `@/lib/db`.
O pool nativo de `pg` é criado sob demanda. Scripts usam TypeScript nativo do Node e
`--env-file-if-exists`; não foi necessário instalar `tsx` ou `@next/env`.
`server-only` impede o uso do pool em componentes cliente.

### Integração com banco limpo

Crie um database vazio separado, terminado em `_test`, configure `TEST_DATABASE_URL` e execute:

```sh
npm run test:integration
```

A suíte verifica conectividade, migração completa, reaplicação sem mudanças no histórico,
rollback explícito de T-003 e upgrade da fundação T-002, além das constraints das cinco tabelas.
Ela não usa fallback para `DATABASE_URL`.
Se não houver configuração/conectividade, o comando falha explicitamente.
A preparação global recusa schemas `app`/`migration_metadata` e tabelas preexistentes.
O teste de rollback remove/recria somente as tabelas que essa execução criou no banco descartável.
Os testes de domínio usam transações com rollback e não dependem da ordem dos arquivos de teste.
Após a execução, mantenha o banco para inspeção ou recrie apenas esse database descartável
antes de repetir a suíte. O banco de desenvolvimento nunca é resetado pelos testes.

## Verificações

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
```

O typecheck gera os tipos de rotas antes de executar o TypeScript, inclusive em checkout limpo.
`npm run check` agrupa typecheck, lint, formatação e testes.
`npm run format` formata o bootstrap, preservando os documentos originais de contexto.
O Vitest usa o ambiente Node e `react-dom/server`, sem jsdom ou Testing Library.

Com o servidor de produção ativo, em outro terminal PowerShell:

```powershell
$response = Invoke-WebRequest http://localhost:3000 -UseBasicParsing
if ($response.StatusCode -ne 200 -or $response.Content -notmatch '<h1>Analytics AI</h1>') {
  throw 'Falha no smoke check'
}
```

Encerre o servidor com Ctrl+C após a verificação.

## Estrutura

- `src/app/`: layout, página inicial e CSS.
- `src/modules/`: placeholders para auth, tenant, dataset, semantic, metrics, query, dashboard e ai.
- `tests/unit/`: teste mínimo de renderização no servidor.
- `src/lib/db/`, `scripts/db/`, `migrations/`: conexão de metadados e migrações administrativas.
- `tests/integration/`: verificação opt-in com PostgreSQL real.
- `docs/adr/`: decisões de infraestrutura e migrações.
- `docs/` e `tasks/`: documentos de produto, arquitetura e tickets.

Git foi inicializado localmente. CI de provedor fica pendente da escolha da hospedagem do repositório; os comandos acima podem ser reutilizados no pipeline.

## Contexto do projeto

- [Instruções do projeto](AGENTS.md)
- [PRD](docs/PRD.md)
- [TDD](docs/TDD.md)
- [EPIC-01](tasks/EPIC-01-data-foundation.md)
- [Prompt T-001](tasks/T-001-prompt.md)

T-004 e demais tickets permanecem pendentes.
