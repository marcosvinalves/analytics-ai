# TDD — Plataforma de Analytics Assistida por IA

**Version:** v0.1 — repository edition  
**Stage:** Technical Alpha

## 1. Technical objective
Prove one complete reliable vertical slice:

`CSV → Dataset → Semantic Layer → Metric → Semantic Query → Query Engine → KPI/Chart → Ask → Explain`

The Alpha is not intended to prove enterprise scale.

## 2. Architectural decisions

### ADR-001 — Modular monolith
Accepted.

Keep logical module boundaries but deploy simply while the product is early and maintained by a solo developer.

### ADR-002 — Next.js + TypeScript
Accepted for Technical Alpha during T-001.

Next.js App Router + React + TypeScript form the web application in the modular monolith.

### ADR-003 — PostgreSQL metadata
Accepted during T-002. See [ADR-003](adr/ADR-003-postgresql-metadata.md).

Store organizations, workspaces, datasets, semantic metadata, metrics, dashboards and execution metadata.
T-002 creates the empty `app` schema and migration history; T-003 adds only the core metadata hierarchy.
The metadata database (`pg`) is separate from the analytical execution adapter (DuckDB still requires SP-01).

### ADR-004 — Object storage
Use an abstraction for dataset files. Local filesystem is acceptable in local development.

### ADR-005 — DuckDB analytics
**Spike required (SP-01).**

Do not permanently couple the architecture to DuckDB before testing the intended Node/runtime/deployment environment.

### ADR-006 — Semantic Query
Accepted.

Natural language does not directly become arbitrary SQL.

### ADR-007 — Structured LLM output
Accepted.

Structured output still requires semantic validation.

### ADR-008 — LLM provider abstraction
Accepted.

Domain code should not depend directly on one model/provider SDK.

### ADR-009 — Metadata migrations
Accepted during T-002. See [ADR-009](adr/ADR-009-database-migrations.md).

Use `pg` and explicit SQL migrations managed by `node-pg-migrate` for application metadata only.
Keep history in `migration_metadata.history`. Apply migrations through an administrative command,
never during build, startup, development server startup or HTTP requests.
Docker Compose is an optional local PostgreSQL environment; `DATABASE_URL` defines the connection.

### ADR-010 — Core metadata schema
Accepted during T-003. See [ADR-010](adr/ADR-010-core-metadata-schema.md) for columns and constraints.

`app.organizations → workspaces → datasets → dataset_versions → dataset_columns` uses mandatory
parent FKs with DELETE/UPDATE RESTRICT, UUIDv4 database defaults and timestamptz timestamps.
DatasetVersion status uses named CHECK constraints. `source_type` is nonempty text; its supported
vocabulary belongs to the application, not a database enum or connector-specific CHECK.
The updated_at triggers maintain timestamps only, not authorization, versioning or immutability.
No authorization, RLS, upload, storage adapter or analytical engine is implemented in T-003.

## 3. High-level architecture

```text
Browser
  ↓
Web Application
  ↓
Application Layer
  ├─ Auth/Tenant
  ├─ Dataset
  ├─ Semantic
  ├─ Metrics
  ├─ Query
  ├─ Dashboard
  └─ AI Orchestrator
       ↓
Infrastructure
  ├─ PostgreSQL metadata
  ├─ File/Object Storage
  ├─ Analytical Adapter (DuckDB candidate)
  └─ LLM Provider
```

These are code/domain boundaries, not microservices.

## 4. Domain responsibilities

### Auth/Tenant
Identity, membership, roles, tenant context.

### Dataset
Upload, dataset versions, schema, profiling, preview.

### Semantic
Business names, dimensions, measures, descriptions and semantic metadata.

### Metrics
Governed calculations, dependencies, formats and lifecycle.

### Query
Semantic Query validation, compilation and analytical execution.

### Dashboard
Dashboard definitions, widgets and filters. Must reuse Query module.

### AI
Schema assistance, intent generation, clarification and explanation. Must not become calculation authority.

## 5. Logical data model

```text
Organization 1 ─ N Membership N ─ 1 User
Organization 1 ─ N Workspace
Workspace 1 ─ N Dataset
Dataset 1 ─ N DatasetVersion
DatasetVersion 1 ─ N DatasetColumn
Dataset 1 ─ 1..N SemanticModel
SemanticModel 1 ─ N SemanticField
SemanticModel 1 ─ N Metric
Metric 1 ─ N MetricDependency
Workspace 1 ─ N Dashboard
Dashboard 1 ─ N DashboardWidget
Workspace 1 ─ N Conversation
Conversation 1 ─ N Question
Question 1 ─ 0..1 QueryExecution
```

Minimum tables/entities:
- organizations
- users
- memberships
- workspaces
- datasets
- dataset_versions
- dataset_columns
- semantic_models
- semantic_fields
- metrics
- metric_dependencies
- dashboards
- dashboard_widgets
- conversations
- questions
- query_executions

## 6. Dataset lifecycle

```text
Upload
 ↓
Validate file
 ↓
Store immutable raw file
 ↓
DatasetVersion(PROCESSING)
 ↓
Profile / inspect
 ↓
Persist schema/profile
 ↓
DatasetVersion(READY)
 ↓
User review
 ↓
Semantic bootstrap
```

Failure:
`PROCESSING → FAILED`

Do not mutate the raw uploaded file in place.

## 7. Semantic Layer
The Semantic Layer maps physical data to business meaning.

Example:

```text
quantity    → quantity
unit_price  → unit_price
category    → category
date        → sale_date

Metric revenue:
SUM(quantity * unit_price)
```

### Metric expression
Prefer a small typed AST over arbitrary SQL as the primary metric definition.

Example:

```json
{
  "op": "sum",
  "args": [{
    "op": "multiply",
    "args": [
      {"field": "quantity"},
      {"field": "unit_price"}
    ]
  }]
}
```

Initial operators:
- field
- literal
- sum
- count
- count_distinct
- avg
- min
- max
- add
- subtract
- multiply
- divide

## 8. Semantic Query contract

Example:

```json
{
  "version": 1,
  "datasetId": "ds_123",
  "metrics": ["revenue"],
  "dimensions": ["category"],
  "filters": [{
    "field": "sale_date",
    "operator": "between",
    "value": ["2026-08-01", "2026-08-31"]
  }],
  "orderBy": [{
    "field": "revenue",
    "direction": "desc"
  }],
  "limit": 10
}
```

Validation rules:
- dataset belongs to current authorized workspace;
- metric/dimension exists in published semantic model;
- clients/LLMs do not directly reference unauthorized physical fields;
- operators must match field type;
- server applies query/result limits;
- proposed/unapproved metrics are not silently treated as governed metrics;
- division has explicit zero/null behavior.

## 9. Query pipeline

```text
SemanticQuery
 ↓
Authorization
 ↓
Semantic validation
 ↓
Resolve metric AST
 ↓
Build query plan
 ↓
Compile parameterized SQL
 ↓
Execution adapter
 ↓
Normalized ResultSet
```

Filter values must be parameterized. Identifiers come only from authorized metadata.

## 10. AI pipeline

```text
Question
 ↓
Load allowed semantic context
 ↓
LLM intent
 ↓
Structured Intent
 ├─ ANSWERABLE
 ├─ CLARIFICATION_REQUIRED
 └─ UNSUPPORTED
 ↓
Intent → Semantic Query
 ↓
Server validation
 ↓
Query Engine
 ↓
Structured Result
 ↓
LLM explanation
 ↓
Answer + provenance
```

Initial intent types:
- value
- trend
- ranking
- comparison
- breakdown

## 11. Initial API surface

```text
POST  /api/workspaces/:id/datasets
GET   /api/datasets/:id
GET   /api/datasets/:id/preview
PATCH /api/datasets/:id/columns/:columnId
GET   /api/datasets/:id/profile

GET   /api/semantic-models/:id
POST  /api/semantic-models/:id/metrics/suggest
POST  /api/semantic-models/:id/metrics
PATCH /api/metrics/:id

POST  /api/query
POST  /api/ask
POST  /api/ask/:questionId/feedback
GET   /api/query-executions/:id/explain

POST  /api/dashboards
GET   /api/dashboards/:id
```

Exact API conventions may evolve during implementation.

## 12. Security
- Resolve tenant context server-side.
- Verify membership before every protected resource operation.
- Never use frontend visibility as authorization.
- Use unpredictable storage keys.
- Validate file extension/MIME/size and parse defensively.
- Never return connector secrets.
- Minimize dataset content sent to an LLM.
- Redact sensitive content from logs.
- Consider PostgreSQL RLS later as defense in depth, not as the only authorization mechanism.

## 13. Observability
Track:
- request id / duration / status;
- dataset processing stages;
- query execution id / duration / row count / timeout;
- AI operation / provider/model / latency / token/cost metadata when available;
- product events such as upload_completed, metric_approved, dashboard_generated, question_asked and explanation_opened.

Do not log raw sensitive dataset content by default.

## 14. Performance
Do not promise production limits before benchmarking.

Use configurable limits:
- MAX_UPLOAD_BYTES
- MAX_QUERY_ROWS
- QUERY_TIMEOUT_MS
- preview/page limits

Ask queries should receive a default limit and never become unrestricted `SELECT *`.

## 15. Suggested source layout

```text
src/
  app/
    (auth)/
    (product)/
      home/
      data/
      metrics/
      dashboards/
      ask/
    api/
  modules/
    auth/
    tenant/
    dataset/
      application/
      domain/
      infrastructure/
    semantic/
    metrics/
    query/
    dashboard/
    ai/
  components/
    ui/
    data/
    charts/
    ai/
  lib/
    db/
    storage/
    observability/
    validation/
  contracts/
    semantic-query/
    api/
tests/
  unit/
  integration/
  e2e/
  fixtures/
```

Adapt to the actual repository instead of forcing this structure blindly.

## 16. Testing strategy
Required:
- Metric AST unit tests
- Semantic Query validation tests
- Query compiler golden tests
- CSV parser fixtures
- ground-truth analytical integration tests
- AI intent eval fixtures
- tenant isolation tests
- happy-path E2E

## 17. Ground truth
Before LLM integration, create a versioned sales dataset with known answers.

At minimum know:
- total revenue;
- revenue by category;
- revenue by month;
- highest/lowest category;
- comparison between selected periods.

Any compiler/semantic change must continue to match ground truth.

## 18. Technical spikes
- SP-01: DuckDB Node/runtime/deployment compatibility.
- SP-02: raw CSV vs CSV→Parquet normalization.
- SP-03: same web process vs separate analytical worker.
- SP-04: LLM structured-intent baseline.
- SP-05: tenant isolation/security model.

## 19. Vertical Slice Definition of Done
- CSV can be uploaded and reopened.
- Schema and preview work.
- Revenue metric is defined and approved.
- Semantic Query returns total revenue and revenue by category.
- Dashboard reuses the same Query Engine.
- “Qual foi a receita em agosto?” produces structured intent and correct result.
- Material ambiguity produces clarification.
- “Como calculamos” exposes metric, filters, source and freshness.
- Tenant isolation tests pass.
- Ground-truth tests pass in CI.

## 20. NOT NOW
No Kubernetes, Kafka, microservices, own DW/OLAP, full ETL editor, autonomous agents, enterprise SSO, complete RLS/CLS, realtime streaming, own LLM, dozens of connectors or dozens of charts during Alpha.
