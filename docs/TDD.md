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
Accepted for T-004. See [ADR-004](adr/ADR-004-local-raw-storage.md).
Use a minimal RawStorage contract (stage, publishOnce, discard, remove) with local filesystem.
Server-controlled UUID keys, exclusive immutable publication, and explicit compensation after
confirmed database rollback. Preserve raw objects on uncertain COMMIT outcomes.
The upload flow is development-only scaffolding, NOT authentication, authorization or tenant security.

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

### ADR-011 — SemanticModel and revisions

Accepted for EPIC-02/T-010. See [ADR-011](adr/ADR-011-semantic-model-revisions.md).

SemanticModel is the stable semantic identity of one Dataset during the Technical Alpha.
SemanticModelRevision binds an explicit DRAFT to one READY DatasetVersion. The revision does not
duplicate dataset_id; the internal writer validates the shared Dataset inside its transaction.
T-010 creates DRAFT only. Publication, archival and immutable published content belong to T-013.
published_at is the original publication instant and must be preserved by a future
PUBLISHED-to-ARCHIVED transition.

Creation payload equality is only createSemanticModelDraft idempotency semantics. It does not make
drafts immutable; drafts remain conceptually editable in subsequent tickets.

A future SemanticField DECIMAL declaration defines semantic intent, precision and scale, but not
the physical conversion strategy by itself. Casting an already materialized DOUBLE to DECIMAL does
not guarantee recovery of the original decimal. T-009 obtained exact precision by reading the
original CSV text before the decimal cast. The EPIC-03 compiler must handle this distinction
explicitly; EPIC-02 does not compile or execute it.

### ADR-012 — Semantic Fields and Type System

Accepted for EPIC-02/T-011. See [ADR-012](adr/ADR-012-semantic-fields-type-system.md).

SemanticField is revision-owned and explicitly maps to a DatasetColumn from the same
DatasetVersion. Controlled dataset_version_id redundancy and composite foreign keys enforce this
physical lineage in PostgreSQL. id identifies a revision row; field_key is the stable logical
identity intended for explicit reuse across future revisions.

The initial semantic types are STRING, BOOLEAN, INTEGER, DECIMAL, NUMBER, DATE, DATETIME and
INSTANT. TypeCompatibility describes whether semantic intent is admissible, not whether an
execution strategy has already been implemented. In particular, DOUBLE-to-DECIMAL is EXPLICIT and
does not recover original decimal precision from a materialized binary value. DATE-to-DATETIME is
INVALID; no implicit midnight policy exists. T-011 performs no DuckDB query or conversion.

Only DRAFT fields can be created, updated or removed. Publication and complete immutable-content
enforcement remain T-013 work.

### ADR-013 — Metrics and Expression AST

Accepted for EPIC-02/T-012. See [ADR-013](adr/ADR-013-metrics-expression-ast.md).

Metric expressions use a closed, engine-independent AST v1 stored as JSONB. Field references use
field_key and are projected into a minimal relational reference table so PostgreSQL can enforce
same-revision lineage and block orphan removal. Result types are derived, not persisted. Metrics
never contain SQL or compiled analytical expressions.

INTEGER combined with DECIMAL promotes to DECIMAL(38, scale) without treating INTEGER as
DECIMAL(38,0) or reducing scale. Overflow outside that explicit envelope belongs to future
execution. COUNT and COUNT_DISTINCT return semantic INTEGER cardinality; this does not assert the
same physical representation as an INTEGER SemanticField. T-012 performs no DuckDB execution.

### ADR-014 — Semantic validation and publication

Accepted for EPIC-02/T-013. See
[ADR-014](adr/ADR-014-semantic-validation-publication.md).

Content validation is deterministic, read-only and independent from lifecycle eligibility. A
publishable snapshot requires a READY DatasetVersion, at least one SemanticField, at least one
Metric, valid physical lineage and type compatibility, valid Metric AST/type inference, and an
exact match between AST field keys and `metric_field_references`.

Publication locks SemanticModel then SemanticModelRevision, validates inside the transaction,
archives the previous published revision and publishes the target atomically. PostgreSQL guards
allow only DRAFT-to-PUBLISHED and PUBLISHED-to-ARCHIVED, preserve the original `published_at`, and
make PUBLISHED/ARCHIVED revision metadata and semantic content immutable to direct DML.

### ADR-015 — Semantic Model Inspection

Accepted for EPIC-02/T-014. See [ADR-015](adr/ADR-015-semantic-model-inspection.md).

`SemanticModelInspection` is a PostgreSQL-independent, read-only contract for a specific semantic
revision or the active PUBLISHED revision. It exposes fieldKey/metricKey identities, physical
lineage without internal row IDs, normalized ASTs, derived result types and field-key dependencies.
Every successful inspection is semantically consistent; invalid metadata returns issues without a
partial snapshot or repair.

Resolution and content reads execute in one `REPEATABLE READ READ ONLY` transaction. Four metadata
queries load the revision, fields, metrics and reference projection without N+1 or writer locks.
Inspection performs no analytical execution and does not generate SQL.

### ADR-016 — Semantic Query Contract

Accepted for EPIC-03/T-015. See [ADR-016](adr/ADR-016-semantic-query-contract.md).

`SemanticQueryV1` is a closed, versioned domain contract parsed from `unknown`. It selects one to
four metrics by metricKey, up to three dimensions by fieldKey, bounded filters with implicit AND,
bounded output ordering and an optional semantic limit. Exact-key validation excludes SQL,
physical names and unknown properties at every level. T-015 performs structural validation only;
semantic resolution against `SemanticModelInspection` begins in T-016.

Literals use explicit discriminated types. INTEGER, DECIMAL and NUMBER remain canonical strings;
T-015 never converts NUMBER to JavaScript number or decides whether an engine can represent it.
DATE and DATETIME have strict timezone-free forms, while INSTANT V1 accepts only explicit UTC `Z`.
NULL is represented only by `IS_NULL` and `IS_NOT_NULL`.

The parser reconstructs and deeply freezes valid queries. Fixed-order canonical JSON is limited to
16 KiB UTF-8. Its JSON and byte count are parser metadata used only for size enforcement,
determinism and tests; they are not query identity, persistence, history or cache data. An absent
semantic limit remains absent. Future execution safety caps must not silently change its meaning.

### ADR-017 — Semantic Query Validation & Resolution

Accepted for EPIC-03/T-016. See
[ADR-017](adr/ADR-017-semantic-query-resolution.md).

`resolveSemanticQuery` is a pure boundary between a structurally valid `SemanticQueryV1` and a
semantic query resolved against one consistent PUBLISHED `SemanticModelInspection`. DRAFT and
ARCHIVED snapshots are not executable. Metrics retain their inspection-owned AST, result type and
resolved field dependencies; dimensions and filters retain semantic field metadata and physical
lineage without interpreting it.

Filter literals require an exact SemanticType match. Ordered comparisons are limited to numeric
and temporal types. DECIMAL literals must fit the declared precision and scale without conversion,
rounding or truncation. INTEGER receives no invented precision, and NUMBER receives no physical
range validation. Physical capability remains T-017 work.

The resolved contract is reconstructed and omits descriptions. `publishedAt` remains a cloned
`Date`; it is not serialized at this boundary and does not share its reference with the inspection.
Dimensions precede metrics in future output ordering. The semantic limit remains absent when not
requested, independently of future execution safety caps. T-016 performs no I/O, SQL, source
resolution, physical planning or execution.

### ADR-018 — Physical Expression Planning

Accepted for EPIC-03/T-017. See
[ADR-018](adr/ADR-018-physical-expression-planning.md).

`resolveAnalyticalSource` resolves a workspace-scoped READY CSV DatasetVersion through a short
read-only PostgreSQL transaction followed by local material validation. The concrete path remains
inside an opaque material handle; it is not ordinary PhysicalQueryPlan data, an error, a DTO or a
client/compiler parameter. Size and stat identity support future pre/post execution checks without
hashing every query.

`planPhysicalQuery` is pure, synchronous and deterministic. It verifies query/source identities and
exact lineage, then produces a self-contained PhysicalQueryPlan. CSV is read initially as text.
Global validation covers header, columns/order, duplicates, row shape and expected row count.
Only used fields receive value conversion policies; inferred physical type is planning metadata,
not global token revalidation.

DECIMAL uses raw text through TEXT_TO_EXACT_DECIMAL and never materialized DOUBLE. Mixed decimal
arithmetic records EXACT_DECIMAL and the semantic result envelope without imposing a generic
INTEGER-to-DECIMAL(38,0) cast. NUMBER records TEXT_TO_FINITE_DOUBLE with non-finite, overflow and
underflow-to-zero errors; authoritative representability remains T-018/T-019 work and no value is
converted with JavaScript Number.

Physical expressions, filters, dimensions, metrics, output descriptors, output-index ordering and
semantic limit contain no SQL. COUNT/COUNT_DISTINCT have physical BIGINT and semantic INTEGER.
There is no safety cap, execution, migration or dependency in T-017.

### ADR-019 — DuckDB Query Compiler

Accepted for EPIC-03/T-018. See
[ADR-019](adr/ADR-019-duckdb-query-compiler.md).

`compilePhysicalQuery` is a pure boundary from `PhysicalQueryPlan` to an internal `CompiledQuery`.
Only the compiler owns analytical SQL. The material path remains behind its opaque handle and is
represented by a bound `MATERIAL_PATH`; values are bound parameters and identifiers use
DuckDB-specific quoting.

CSV is materialized per execution on a dedicated DuckDB connection with every column initially
VARCHAR. Typed validation commands cover global source shape and only the used field values before
the analytical query. Exact DECIMAL starts from raw text and validates lexical scale and envelope
before casting. DuckDB 1.5.5 proved direct HUGEINT × DECIMAL(18,2) and SUM as DECIMAL(38,2), with no
DOUBLE intermediary. NUMBER inputs and results must remain finite.

Compiled temporary state lives only for the dedicated connection and is cleaned up by closing it.
UTC is a semantic session requirement; resource limits, execution, safety caps and typed results
remain T-019. T-018 adds no migration or dependency.

### ADR-020 — Query Execution & Typed Results

Accepted for EPIC-03/T-019. See
[ADR-020](adr/ADR-020-query-execution-typed-results.md).

`executeCompiledQuery` accepts only an in-process `CompiledQuery` capability registered by the
compiler. Material paths remain behind the opaque handle and are bound as VARCHAR. File identity
is checked before analytical work and before returning. Each call owns an in-memory DuckDB instance
and connection configured for UTC, two threads, 256 MB memory, no spill and no automatic extension
loading.

The executor consumes the compiled lifecycle without generating, parsing or rewriting SQL. Real
interruption backs a ten-second timeout and optional AbortSignal. Streaming detects more than 500
result rows without changing semantic limit; public result payload is capped at 4 MiB with
incremental UTF-8 accounting. These caps complement engine memory containment and do not imply that
GROUP BY or ORDER BY evaluates only the exposed rows.

Typed results preserve integers and decimals as exact strings, NUMBER as a finite deterministic
string and temporals as textual values with microseconds, without JavaScript Date. Output metadata
contains logical key, label, role and semantic type only. No PostgreSQL access, persistent mutation,
migration or dependency is introduced.

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

T-004 implements only receive/stage, metadata validation, immutable raw publication and a short
transaction creating Dataset + DatasetVersion(PROCESSING, CSV). It adds original_filename and
size_bytes through an additive migration. The default configurable Alpha ingestion limit is 10 MiB.
No CSV parsing, profiling, columns, READY transition, workers or queues are implemented yet.
The local UI is `/data/upload`; its POST endpoint uses a server-configured workspace and resolves
organization in PostgreSQL. It is disabled in production regardless of its opt-in flag.

<!-- T-005: internal metadata lifecycle, not analytical execution. -->

### T-005 — DatasetVersion lifecycle

Internal functions `markDatasetVersionReady(pool, input)` and
`markDatasetVersionFailed(pool, input)` accept native `pg.Pool` (autocommit) or `pg.PoolClient` (caller-owned transaction).
With a transactional client, TRANSITIONED is provisional until the caller commits; these functions
never BEGIN/COMMIT/ROLLBACK. T-007 uses READ COMMITTED.
Inputs include server-resolved workspaceId and datasetVersionId; the workspace predicate is
resource scoping, NOT authentication or authorization. No public endpoint is added.

Only PROCESSING → READY/FAILED is allowed. Repeated terminal transitions return ALREADY_TERMINAL,
even to the same status, without changing timestamps. PROCESSING → PROCESSING is not exposed.
Each UPDATE includes status = PROCESSING and the workspace relationship. A competing writer
waits and rechecks this predicate; only one can win. If RETURNING is empty, a separate scoped
SELECT distinguishes NOT_FOUND from ALREADY_TERMINAL using a fresh snapshot. It never authorizes
a second UPDATE. Success returns TRANSITIONED with processing fields and timestamps.

READY requires rowCount as bigint in [0, 9223372036854775807] and integer columnCount in
[1, 2147483647], preserving the existing positive-column READY constraint. Timestamp comes
from statement_timestamp(); both error fields become NULL. FAILED preserves partial counts,
sets processed_at, and requires a string errorCode of 1–64 characters matching
`[A-Z][A-Z0-9_]*`, with no whitespace (including trailing newline), coercion or Error objects.
Codes such as CSV_PARSE_FAILED and SCHEMA_INFERENCE_FAILED need no lifecycle architecture change.
The caller must supply a symbolic machine code, never transform exception/SQL/secret content
into a code: syntactic validation cannot identify a secret that happens to match this alphabet.
errorMessage is NULL by default or exactly `Não foi possível processar o dataset.`; arbitrary
messages are rejected at runtime. Argument failures occur before SQL. Database errors are
replaced by a safe LIFECYCLE_OUTCOME_UNKNOWN error without SQL, stack payload or credentials.
No automatic retry, cleanup or FAILED transition occurs after an uncertain write outcome.

Lifecycle UPDATEs never change identity/origin fields, created_at or raw storage. updated_at
is maintained by the existing trigger. These guarantees apply to this API; administrative SQL
can still bypass terminality or reassign resources. Concurrent deletion can cause the diagnostic
SELECT to return NOT_FOUND. A PROCESSING result after an unsuccessful conditional update signals
an external invariant violation and fails conservatively. No new migrations or dependencies.

T-004 remains unchanged: new Dataset + version 1 in PROCESSING. There is no lifecycle call during
upload. Future same-dataset numbering should lock the Dataset row with FOR UPDATE, then calculate
and insert the next number in the same short transaction, retaining UNIQUE(dataset_id, version_number).
Advisory locks need a shared convention; persisted counters add state; unique-conflict retries add
rollback/retry policy. Nothing is implemented now. Revisit a persistent counter if future deletion
must never permit number reuse.

PostgreSQL tests use committed isolated fixtures and independent connections. A coordinator holds
a row lock until both competing UPDATEs are observed waiting in pg_stat_activity, then releases it.
READY/READY and READY/FAILED must each produce one winner and one terminal result, without mixed fields.
Use a fresh dedicated TEST_DATABASE_URL; never transition user uploads for demonstration.

T-006 completed with ACCEPT WITH CONDITIONS; see docs/spikes/SP-01-duckdb.md.
T-007 adds explicit local processing, without wiring it into upload or Next.js routes.

### T-007 — Persist schema/profile

`processDatasetVersion(pool, {workspaceId, datasetVersionId})` returns TRANSITIONED,
ALREADY_TERMINAL, NOT_FOUND, or OPERATIONAL_FAILURE with a safe code/message. Invalid scope
throws a safe TypeError before IO. Scope is server-controlled, not authorization.
The local command is documented in README; no endpoint, UI, worker or automatic retry is added.

Read the immutable local raw object outside a PostgreSQL transaction. Reject symlinks and
invalid storage keys, check size and UTF-8, and compare SHA-256 before/after inspection.
DuckDB reads strict comma-delimited UTF-8 CSV with header, double-quote escaping, full-file
inference and empty-field NULL semantics. Empty raw is invalid; header-only CSV is accepted.
Duplicate/empty headers use DuckDB's normalized physical names. Persist canonical DuckDB
type strings without financial or semantic reinterpretation (DOUBLE remains DOUBLE).
Counts use bigint. Only row count, column count, names, types, ordinal and null count are stored;
profile_metadata remains NULL and null_ratio is derived, never persisted.

ADR-010 defines nullable=NULL as unknown. CSV cannot prove a structural NOT NULL constraint:
null_count > 0 produces true; zero produces NULL, never false. No schema change is needed.

A short transaction locks the scoped DatasetVersion and its Dataset relationship, rechecks
identity/status, requires no existing columns, inserts the complete schema, and invokes T-005
READY on the same PoolClient before COMMIT. Rollback leaves PROCESSING with no partial columns.
Competing terminal transitions have a single winner. Existing terminal versions are unchanged.
No raw deletion or mutation is performed.

Only definitive local raw absence/identity failure (RAW_OBJECT_UNAVAILABLE) or validated
invalid CSV/UTF-8/empty data (CSV_READ_FAILED) may invoke FAILED, with the fixed safe lifecycle
message. Missing storage root, permissions, configured size limit, database/runtime failures,
OOM and unknown parser errors are operational: do not mark FAILED. PROCESSING is preserved
when rollback is confirmed; uncertain COMMIT may already have produced READY and returns
PROCESSING_OUTCOME_UNKNOWN. Inspect state before an explicit new attempt. No automatic retry.
Unknown DuckDB errors fail conservatively rather than exposing internal exception text.

DuckDB is in-memory, with two threads, 256 MB engine memory, no disk spill or extension auto-load.
These settings are not OS memory/process isolation or an end-to-end timeout. The private local
storage directory must be operator-controlled; fingerprints are not protection against a hostile
OS user concurrently replacing files. Local missing-file classification assumes a healthy root.
The native binding is promoted to runtime for the CLI. Passing the Next.js build does not verify
native bundling inside a future Next.js route or deployment target. No migrations or new packages.


### T-008 — Read-only Data Preview

Local-only `/data` lists at most 50 recent datasets in the server-configured workspace.
`/data/datasets/[datasetId]?version=<uuid>` selects an explicitly scoped version, or the highest
version_number when omitted. IDs select resources; they do not authorize access. The existing
development-only context remains disabled in production. No new HTTP API or auth/RLS is added.

Metadata and ordered DatasetColumns come from PostgreSQL in a short REPEATABLE READ READ ONLY
transaction. It ends before raw inspection. Only READY opens DuckDB. PROCESSING/FAILED do not
read the raw. The page checks scope/existence before its Suspense boundary so missing resources
produce HTTP 404 rather than a streamed 200. Metadata/schema remain visible during preview loading.

PreviewCell is `{column: string, value: string | null}`; PreviewRow is PreviewCell[].
This is a Data Preview DTO, not the future Query Engine contract. BIGINT/DECIMAL and temporal
values are converted to VARCHAR in DuckDB, never through Number or JS Date. DOUBLE remains
approximate; NULL remains null; TIMESTAMPTZ uses UTC, while TIMESTAMP has no invented timezone.

The fixed CSV reader reuses T-007 dialect options with auto_detect=false and persisted names/types.
A fixed VARCHAR header read checks normalized names without schema inference; allowed type syntax
and escaped SQL identifiers/literals protect the generated projection. The path is server-resolved,
bound as a value, and validated for containment/symlinks/size. The query returns at most 50 rows.
SHA-256 before/after detects changes during reading, not historical identity (no persisted checksum).
Observed incompatible raw/schema returns safe PREVIEW_READ_FAILED; READY and DatasetColumns remain
untouched. No lifecycle calls, corrective processing, row persistence, polling or retry are added.

Native DuckDB is externalized only after a reproduced build failure resolving foreign-platform
bindings. The real production routes remain blocked. A minimal generated Next harness imports the
same permanent reader and proves native loading and query execution in compiled Node runtime on
Windows x64. This does not certify other deployment environments, standalone tracing or load.
See docs/T-008-data-preview.md for checks, limitations and files. No migrations or new dependencies.

### T-009 — Deterministic ground-truth aggregation

The explicit local command calls `runGroundTruthAggregation(pool, {workspaceId,
datasetVersionId})`. It is specific to `SUM(quantidade * preco_unitario)`: no user SQL,
expression, generic engine/AST, endpoint or UI. The server resolves workspace, metadata and raw.
Only READY is read; PROCESSING/FAILED return NOT_READY and missing/wrong scope returns NOT_FOUND.

Metadata uses a short REPEATABLE READ READ ONLY transaction that ends before DuckDB. The raw path,
UTF-8, size, fingerprint, normalized header and full persisted physical schema are validated with
the shared T-007/T-008 concrete infrastructure. Required persisted columns must exist and be numeric.
No schema inference, metadata correction, lifecycle call, result persistence or automatic retry.

Original CSV text is read separately. Quantity accepts signed integer text fitting DECIMAL(18,0).
Unit price accepts signed plain decimal text with at most two fractional digits fitting
DECIMAL(18,2). Scientific notation, excess scale, whitespace, NaN/Infinity and fractional quantity
are errors; multiplication/sum overflow is an explicit error. This is a rule for this experiment,
not a semantic MONEY inference from a column name.

DuckDB 1.5.5 `typeof()` was verified at runtime: quantity DECIMAL(18,0), unit price DECIMAL(18,2),
product DECIMAL(18,2), SUM DECIMAL(38,2). No numeric cast is added after SUM to manufacture that
type. The exact DECIMAL is cast only to VARCHAR at the serialization boundary. The operation checks
all four observed types and returns value as string/null plus rowCount/contributingRows strings.

NULL in either operand excludes that row. No contributing rows returns null; an actual zero returns
`"0.00"`. The versioned synthetic fixture expects `"17.30"`, independently derived with Node
BigInt cents. The real 20-row dataset returned `"2059.61"`, matching the pre-existing SP-01 Python
Decimal oracle. Five-table snapshots and raw hashes prove no writes. See
docs/T-009-ground-truth-aggregation.md. No migration or dependency.

## 7. Semantic Layer
The Semantic Layer maps physical data to business meaning.

Semantic definitions are edited in DRAFT revisions. Explicit publication creates an immutable
snapshot; publishing a newer valid revision atomically archives the previously published snapshot.
Validation never runs analytical queries.

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
