# SP-01 — DuckDB Technical Spike

Data: 20/09/2026. Decisão: **ACCEPT WITH CONDITIONS**, restrita ao experimento local.
T-007 não iniciado. Nenhuma integração com módulos de produto foi criada.

## Objetivo e isolamento

Avaliar leitura e análise determinística de um CSV real publicado pelo T-004, sem modificar
o raw, finalizar DatasetVersion, persistir DatasetColumn ou construir Query Engine.
Scripts em `scripts/spikes/duckdb/` e uma dependência de desenvolvimento são removíveis.
Python é somente oracle independente do spike, não dependência do produto.

## Ambiente efetivamente testado

| Componente | Versão/ambiente |
| --- | --- |
| @duckdb/node-api | 1.5.5-r.5, versão instalada lida do package.json do pacote |
| @duckdb/node-bindings | 1.5.5-r.5, transitivo |
| Binário da plataforma | @duckdb/node-bindings-win32-x64@1.5.5-r.5 |
| DuckDB engine | v1.5.5, retornado por SELECT version() |
| Node | v22.23.2, exigido pelo script |
| npm | 11.12.1 na instalação e checks |
| SO | Windows 11 Pro, release 10.0.26200, win32/x64 |
| CPU | 12th Gen Intel Core i5-12400F |
| Python | 3.12.10; somente csv, decimal, json e biblioteca padrão |
| Aplicação existente | Next.js 16.3.5, React 19.3.0, TypeScript 5.9.3, ESM |
| Integração PostgreSQL dos checks | PostgreSQL 18.6, cluster separado e descartável |

O Node global da máquina é diferente; não foi usado para concluir compatibilidade.
Não foi necessário compilar o binding nativo localmente. Instalação npm: zero vulnerabilidades reportadas.

## Reprodução

Ativar Node 22.23.2, executar npm ci e ter Python 3.12 disponível como `python`.
DATABASE_URL e LOCAL_STORAGE_ROOT são carregados de `.env.local`, sem imprimir credenciais.

```sh
npm run spike:duckdb -- --version-id a7eaab8d-9ad2-44c5-a742-d7b02a87c72c
```

O UUID identifica um upload local existente, não é fixture criado por este script.
Em outro ambiente, fornecer o UUID correspondente de um upload pelo T-004 com as mesmas colunas
e domínio numérico, ou usar o mesmo raw preservado por esse pipeline. O CSV real não foi copiado
para o repositório. Sua disponibilidade local é uma pré-condição documentada da reprodução.

O experimento consulta a referência no banco em transações READ ONLY, valida namespace/chave,
contenção no storage e ausência de symlinks/junctions. Nunca importa ou chama o lifecycle.
Calcula SHA-256 do raw e hashes de todas as linhas ordenadas das cinco tabelas de app e do histórico
de migrations, antes e depois. O relatório local em `.local/spikes/duckdb/result.json` contém as
evidências completas. O comando também imprime preview/resultados: execute somente em terminal local.
`result-first.json` conserva a execução anterior usada na comparação entre processos desta sessão.

## Experimento

Cada comando abre duas instâncias independentes em memória, sequencialmente, com fechamento
explícito de conexão/instância. Configuração: threads=2, memory_limit=256MB, diretório temporário
privado em `.local/spikes/duckdb/tmp`, sem autoload/autoinstall de extensões. O acesso externo é
habilitado para ler o arquivo local; o script executa somente SQL fixo e caminhos parametrizados.
Isso não é uma sandbox para SQL arbitrário nem uma política de recursos de produção.

Leitura: `read_csv`, header=true, delim=',', sample_size=-1, nullstr='', allow_quoted_nulls=true,
ignore_errors=false e strict_mode=true. Delimitador/header/NULL são explícitos; os tipos são inferidos.
Todos os registros entram na inferência deste arquivo pequeno. Campos vazios, entre aspas ou não,
são NULL por decisão explícita deste experimento, não por uma regra universal de produto.

A leitura automática materializa uma tabela temporária apenas no DuckDB em memória. Executamos
DESCRIBE, COUNT(*), contagem de NULL por coluna, preview ORDER BY ALL LIMIT 5 e a soma conhecida.
A leitura monetária separada usa all_varchar=true e converte diretamente o texto original para
DECIMAL(18,0) na quantidade e DECIMAL(18,2) no preço; não converte um DOUBLE já inferido.
Python verifica antes que quantidades são integrais e preços cabem em duas casas sem arredondar.
Outros domínios numéricos exigem outro contrato explícito; overflow/conversão inválida não é ignorado.

## Fonte e schema inferido

Raw publicado pelo T-004, 1.286 bytes, **20 registros**, 7 colunas. DatasetVersion permaneceu PROCESSING.

| Coluna | Tipo inferido | NULLs observados |
| --- | --- | ---: |
| data_venda | DATE | 0 |
| produto | VARCHAR | 0 |
| categoria | VARCHAR | 0 |
| cidade | VARCHAR | 0 |
| quantidade | BIGINT | 0 |
| preco_unitario | DOUBLE | 0 |
| receita | DOUBLE | 0 |

Python confirmou os mesmos nomes, 20 registros e zero NULLs nas sete colunas.
DESCRIBE informa nullable=YES nas colunas: isso não significa que existam NULLs no arquivo.

Preview limitado (ordenado; não representa a ordem física original):

| data_venda | produto | categoria | cidade | quantidade | preco_unitario | receita |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 2026-09-01 | Arroz 5kg | Alimentos | São José dos Campos | 3 | 24.9 | 74.7 |
| 2026-09-01 | Feijão 1kg | Alimentos | São José dos Campos | 5 | 8.99 | 44.95 |
| 2026-09-02 | Patinho | Carnes | Jacareí | 4 | 39.9 | 159.6 |
| 2026-09-02 | Peito de Frango | Carnes | São José dos Campos | 8 | 19.9 | 159.2 |
| 2026-09-03 | Leite 1L | Laticínios | São José dos Campos | 12 | 5.49 | 65.88 |

## Ground truth independente e precisão monetária

`ground_truth.py` lê o raw com csv.DictReader e calcula cada quantidade × preço com Decimal,
precisão 80. Não usa DuckDB, valores convertidos pelo binding ou a coluna receita como oracle.
Produtos com operando vazio são excluídos da soma; nenhum produto válido produz NULL, não zero.
O arquivo deste experimento possui 20 produtos válidos.

| Cálculo | Resultado |
| --- | --- |
| SUM(quantidade * preco_unitario), inferência automática | 2059.61 como representação curta do number |
| Valor exato do DOUBLE retornado, via Decimal.from_float | 2059.61000000000012732925824820995330810546875 |
| Diferença binária exata contra Python Decimal | +1.2732925824820995330810546875E-13 |
| SUM com DECIMAL explícito a partir do raw textual | 2059.61, exato |
| Python decimal.Decimal independente | 2059.61, exato |

Não houve arredondamento para fazer os valores coincidirem. O relatório distingue a igualdade da
representação curta da divergência do DOUBLE real. **Não usar inferência DOUBLE como contrato monetário.**

No fixture complementar, soma automática de 0.10 e 0.20 = **0.30000000000000004**;
DECIMAL convertido do texto e Python Decimal = **0.30**. Essa divergência é esperada de ponto
flutuante e permanece visível. Não há types.expected.json: assertions locais e o oracle Python
são suficientes, sem infraestrutura permanente de testes do motor.

## Tipos e comportamento JavaScript

Observados com getRowObjects(), sem conversões globais:

| DuckDB | JavaScript observado | Evidência/limite |
| --- | --- | --- |
| BIGINT | bigint | 9007199254740993 e 9223372036854775807 preservados exatamente |
| DOUBLE | number | Precisão binária exposta acima |
| DECIMAL | DuckDBDecimalValue | toString preserva 2059.61 e 0.30 |
| DATE | DuckDBDateValue | 2026-09-19 preservado como data sem hora |
| TIMESTAMP | DuckDBTimestampValue | 2026-09-19 10:20:30, sem timezone |
| TIMESTAMPTZ | DuckDBTimestampTZValue | 12:00 UTC exibido como 09:00-03 no ambiente local |
| BOOLEAN | boolean | true/false preservados |
| VARCHAR | string | UTF-8, vírgula entre aspas e aspas duplicadas preservados |
| NULL | null | Campo vazio e campo vazio entre aspas produziram NULL |

Coluna mista "12"/"invalid" inferida como VARCHAR. CAST explícito para INTEGER rejeitou
"invalid", sem ignorar a linha. Coluna inteiramente vazia inferida como VARCHAR: tipo físico
não resolve significado de negócio. O fixture tem duas linhas; não pretende ser bateria exaustiva.

getRowObjectsJson() foi usado no relatório: BIGINT vira string, datas/timestamps também têm
representação textual. JSON.stringify direto em bigint não funciona. DECIMAL não deve passar por
Number para transporte financeiro. Nenhum serializador/conversor foi adicionado ao produto.

## Tempos e repetibilidade

Milissegundos observados no último processo; primeira e segunda instâncias:

| Etapa | Execução 1 | Execução 2 |
| --- | ---: | ---: |
| Criar instância + conexão | 11.888 | 9.485 |
| Ler/materializar CSV | 6.641 | 4.724 |
| Schema + count + NULLs + preview | 4.227 | 2.739 |
| Agregação automática | 0.430 | 0.450 |
| Releitura textual + agregação DECIMAL | 3.053 | 2.821 |

Medições com performance.now(), sem tempo de importação do módulo, Python, consultas PostgreSQL
ou startup inteiro do processo. A soma automática usa tabela já materializada; DECIMAL inclui
releitura. Não são alternativas medidas sob condições equivalentes. Caches do SO podem estar quentes.
Não há SLA, limiar de aceite de performance ou inferência de escalabilidade a partir de 20 linhas.

As duas instâncias produziram resultados idênticos, exceto tempos/ordinal. O comando também foi
executado novamente em **outro processo Node**: comparação estrutural completa, removendo somente
tempos, confirmou os mesmos resultados, hashes e metadados. Ambos os processos encerraram normalmente.

## Preservação do raw e PostgreSQL

SHA-256 antes **e** depois, em todas as execuções:

```text
5588ec80a695b1be608aa0a7783b82c5aa9cd54a0e9fb4a338ea027242843796
```

Hashes das linhas de organizations, workspaces, datasets, dataset_versions, dataset_columns e
migration_metadata.history permaneceram iguais. A versão continuou PROCESSING; zero DatasetColumn
foi criado. O script somente emite SELECT e controle de transações READ ONLY ao PostgreSQL.
Nenhuma migration, chamada READY/FAILED, escrita em storage raw ou alteração de configuração do banco.
Isso verifica dados/metadados da aplicação; não significa ausência de estatísticas internas de acesso
ou de WAL/logs operacionais gerados pelo funcionamento normal do servidor.

## Checks existentes

Executados com Node 22.23.2/npm 11.12.1:

| Check | Resultado |
| --- | --- |
| npm run format | passou |
| npm run typecheck | passou |
| npm run lint | passou após retirar a cópia temporária do checkout |
| npm run format:check | passou |
| npm test | 95 passaram |
| npm run test:integration | 72 passaram, PostgreSQL real isolado |
| npm run test:upload-ui | 3 passaram, Edge; respostas interceptadas como na suíte existente |
| npm run build | passou |

A integração rodou numa cópia do código atual com node_modules compartilhado, sem .env.local e
com TEST_DATABASE_URL exclusivo, para não disputar o lock do servidor Next dev que já estava aberto.
O primeiro lint capturou artefatos gerados nessa cópia temporária dentro do checkout; não eram erros
do produto. A cópia foi movida para `../analytics-sp01-validation-artifacts` e o comando padrão passou.
Ela foi preservada porque a revisão automática bloqueou sua exclusão recursiva.
Avisos não bloqueantes: NO_COLOR/FORCE_COLOR no Playwright e conversão LF/CRLF do Git.

## Conclusões separadas

| Componente | Conclusão baseada no que foi testado |
| --- | --- |
| DuckDB engine v1.5.5 | Leitura, inferência, contagens, preview, NULLs e agregação local corretos; dinheiro exige DECIMAL explícito |
| Node Neo 1.5.5-r.5 | Import ESM, Promises, parâmetros, tipos e fechamento funcionaram neste ambiente |
| Node 22.23.2 | Compatibilidade prática confirmada para o script executado |
| Windows x64 | Binding pré-compilado carregou e funcionou sem compilação local |
| Next.js integration | Somente não regressão do projeto existente; DuckDB NÃO foi importado por Server Components/Route Handlers |
| Deploy alvo | NÃO VERIFICADO: ambiente de hospedagem não foi definido/provisionado neste spike |

**Build aprovado NÃO comprova bundling futuro do DuckDB dentro do runtime Next.js.** Não houve
alteração em next.config.ts, serverExternalPackages ou grafo da aplicação. O script depende de
devDependency e Python; um deploy com npm ci --omit=dev não executará este experimento. Isso é
intencional e não especifica como será empacotada a integração de produto futura.

## Riscos, condições e itens NÃO VERIFICADOS

Decisão final: **ACCEPT WITH CONDITIONS** para prosseguir com a avaliação arquitetural da Alpha.

Condições antes de uma integração definitiva:

1. Validar instalação/import/consultas e inclusão dos binários nativos no SO/arquitetura do deploy alvo.
2. Testar integração Node dentro do Next.js e seu artefato implantado; avaliar externalização/tracing
   somente com evidência, sem adicionar serverExternalPackages preventivamente.
3. Definir política explícita de precisão/escala monetária, BIGINT/DECIMAL e serialização JSON.
4. Definir contratos para inferência, NULLs, timezone/locale, CSV inválido e limites de recursos.
5. Antes de execução no processo web, avaliar concorrência, cancelamento, memória e impacto no event loop.

NÃO VERIFICADOS: Linux/glibc, Linux/musl, ARM, containers, serverless, Edge Runtime, Next standalone,
bundling do binding em rotas, cold start de deploy, carga concorrente, datasets grandes, spill em
disco, cancelamento, interrupção de processo, persistência DuckDB, extensões remotas e SQL não confiável.
Edge não é alvo desta proposta de binding nativo. Local storage pode ser efêmero ou inacessível no
deploy; o fixture local não comprova a futura arquitetura de armazenamento.

O fixture pequeno não valida todos os dialetos CSV, arquivos malformados ou formatos regionais.
A memória configurada não foi testada como teto absoluto de RSS. Inferência não cria Semantics.
Python não é runtime de produto; SQL fixo deste spike não é Query Engine nem API para o usuário.

## Arquivos/dependências e remoção

Criados: este relatório, scripts/spikes/duckdb/run.ts, ground_truth.py e fixtures/types.csv.
Alterados: package.json (comando/dependência) e package-lock.json.
Dependência direta nova: @duckdb/node-api@1.5.5-r.5, somente desenvolvimento; bindings transitivos
e pacote Windows x64 descritos acima. Sem migrations, SDK cloud, parser de produto ou factory.
Remover os scripts, relatório, comando e dependência elimina o spike; artefatos locais são separados
dos raw uploads e não devem ser confundidos com arquivos da aplicação a preservar.

Referências: [Node Neo](https://duckdb.org/docs/current/clients/node_neo/overview),
[código/bindings](https://github.com/duckdb/duckdb-node-neo).
