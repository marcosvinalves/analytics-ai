# PRD — Plataforma de Analytics Assistida por IA

**Status:** Product direction approved for prototype / Technical Alpha  
**Version:** condensed repository edition

## 1. Vision
Create an AI-assisted self-service analytics platform that turns structured business data into understandable metrics, dashboards and answers with much less technical effort while preserving control and traceability.

Working value proposition:

> Conecte seus dados. Faça perguntas. Entenda seu negócio.

Product thesis:

> Analytics self-service assistido por IA, com métricas governadas e respostas rastreáveis.

## 2. Problem
Current BI workflows can require multiple mental models: ingestion/preparation, relationships/modeling, formulas, visualization, publishing and governance.

The opportunity to validate is whether we can substantially reduce the distance between:

`I have data` → `I understand something useful`

without sacrificing trust.

## 3. Primary users

### P-01 — Manager / Business user
Goal: understand what is happening and why without depending on a specialist for every unforeseen question.

JTBD:
> Quando percebo uma mudança importante no negócio, quero investigar os dados sem depender de um especialista, para entender rapidamente o que aconteceu e tomar uma decisão informada.

Key pains:
- dashboard does not answer an unforeseen question;
- technical vocabulary;
- dependence on analysts;
- distrust when calculation/source is unclear;
- excessive interface complexity.

### P-02 — BI / Data analyst
Goal: define reliable reusable metrics/models and reduce repetitive requests.

JTBD:
> Quando preciso disponibilizar dados para usuários de negócio, quero construir modelos e métricas reutilizáveis rapidamente, para que os usuários consigam responder perguntas sem gerar novas solicitações para mim.

Key pains:
- repetitive simple requests;
- repeated dashboards;
- metric/model maintenance;
- inconsistent definitions;
- time spent explaining numbers.

Secondary personas: Data Engineer/IT, Governance/Admin and Embedded Developer.

## 4. Core product principles
- DP-01 Question before tool.
- DP-02 Insight before dashboard.
- DP-03 Business language before technical language.
- DP-04 AI suggests; human decides.
- DP-05 Every important number is traceable.
- DP-06 Complexity on demand.
- DP-07 Empty states guide progress.
- DP-08 Errors explain recovery.
- DP-09 Visualizations prioritize comprehension.
- DP-10 Automation remains editable.
- DP-11 Communicate uncertainty.
- DP-12 Show source and freshness.

## 5. Core architecture/product rule
AI is not the source of truth.

`Data → Semantic Layer → Query Engine → Result`

AI helps with:
- schema interpretation;
- metric/model suggestions;
- natural-language intent;
- explanation.

The Semantic Layer defines meaning. The Query Engine calculates.

## 6. Prototype / Alpha happy path
1. User adds CSV/Excel.
2. System analyzes the dataset.
3. User reviews detected fields/types.
4. System proposes semantic concepts and metrics.
5. User approves/corrects metrics.
6. System generates a first useful dashboard.
7. User asks a business question.
8. Platform interprets the question as structured intent.
9. Query Engine calculates the answer.
10. Platform explains the result and exposes provenance.

## 7. Initial information architecture

### Business mode
- Home
- Ask
- Dashboards
- Alerts

### Analytical mode
- Data
- Metrics
- Model
- Editor

### Administrative mode
- Connections
- Users
- Permissions
- Audit
- Settings

Technical Alpha does not need all these surfaces.

## 8. Prototype / Alpha scope

### Must prove
- CSV ingestion
- data preview / schema inference
- minimal Semantic Layer
- governed metric
- deterministic analytical query
- KPI / basic chart
- natural-language question
- structured intent
- explainable answer

### First visualization set
- KPI
- line
- bar
- table

Additional charts can wait.

## 9. NOT NOW
Do not build these during the initial Alpha:
- own data warehouse;
- own OLAP engine;
- enterprise ETL platform;
- on-premises;
- native mobile app;
- complete embedded analytics;
- enterprise SSO/SAML/SCIM;
- advanced RLS/CLS;
- marketplace/plugins;
- realtime streaming;
- own ML/LLM;
- dozens of connectors;
- sophisticated visual ETL;
- dozens of chart types.

## 10. AI behavior
Preferred path:

`Question → Structured Intent → Semantic Layer → Semantic Query → Validator → Query Compiler → Query Engine → Result → Explanation`

Do not use:

`Question → LLM-generated arbitrary SQL → Database`

If the question is materially ambiguous, ask for clarification instead of silently choosing a meaning.

## 11. Explainability
An analytical answer should be able to expose:
- metric used;
- metric definition;
- filters;
- period;
- dimensions;
- data source;
- freshness;
- technical query for authorized technical users.

Example:

**Margem: 17.8%**

How calculated:
- Net revenue: ...
- COGS: ...
- Gross margin: ...
- Formula: margin / revenue
- Source: sales dataset
- Updated: timestamp

## 12. UX North Star
**TTFI — Time to First Insight**

Definition:
Time between beginning the data workflow and the first correct, useful, understood insight.

Do not optimize merely for time-to-first-chart.

## 13. Validation metrics
Track:
- TTFI
- Task Success
- Time-on-Task
- Error Rate
- Help Rate
- SUS
- confidence/trust
- Ask success
- ambiguity rate
- metric correction rate
- dashboard completion
- negative AI feedback
- explanation open rate

AI pipeline evaluation should distinguish:
`Intent Accuracy → Query Accuracy → Result Accuracy → Explanation Accuracy`

## 14. Roadmap

### S0 — UX prototype
Validate the experience.

### S1 — Technical Alpha
Prove the architecture and vertical slice.

### S2 — Private Beta
Real users + real data; Excel, persistence, PostgreSQL connector likely.

### S3 — V1
Additional database connectors, refresh, relationships, sharing, alerts, billing/admin.

### S4 — Scale
Embedded/API, enterprise governance, SSO, advanced RLS, on-prem/hybrid, broader ecosystem.

## 15. Technical Alpha success condition
A person can import their own dataset and obtain a useful, correct and explainable analytical result through the same semantic/query foundation used by dashboards and Ask.
