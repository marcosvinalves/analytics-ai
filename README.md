# Analytics AI

Bootstrap da Technical Alpha (T-001): Next.js App Router, React e TypeScript.
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

Abra <http://localhost:3000>. Nenhuma variável de ambiente é obrigatória neste ticket.
`.env.example` documenta a convenção; `.env.local` é opcional e ignorado pelo Git.
Nunca coloque segredos em variáveis `NEXT_PUBLIC_`.

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
- `docs/` e `tasks/`: documentos de produto, arquitetura e tickets.

Git foi inicializado localmente. CI de provedor fica pendente da escolha da hospedagem do repositório; os comandos acima podem ser reutilizados no pipeline.

## Contexto do projeto

- [Instruções do projeto](AGENTS.md)
- [PRD](docs/PRD.md)
- [TDD](docs/TDD.md)
- [EPIC-01](tasks/EPIC-01-data-foundation.md)
- [Prompt T-001](tasks/T-001-prompt.md)

T-002 e demais tickets permanecem pendentes.
