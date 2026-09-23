# EPIC-01 — Data Foundation

**Status:** IMPLEMENTED — AWAITING T-009 REVIEW
**Stage:** Technical Alpha

## Goal
Allow a CSV file to enter the product and become a persistent, inspectable and queryable dataset.

This epic proves the data foundation only. It does not implement AI or dashboards.

## Scope
Implement:
1. project bootstrap;
2. PostgreSQL;
3. migrations;
4. minimal Organization / Workspace / Dataset model;
5. CSV upload;
6. storage abstraction;
7. DatasetVersion lifecycle;
8. DuckDB technical spike;
9. schema inspection/inference;
10. basic profiling;
11. DatasetColumn persistence;
12. Data Preview;
13. ground-truth aggregation.

## Dataset states
```text
PROCESSING
READY
FAILED
```

## Out of scope
Do NOT implement:
- LLM/AI;
- Semantic Layer;
- Metric suggestion;
- Ask;
- dashboards;
- alerts;
- billing;
- sharing;
- embedded analytics;
- SSO;
- microservices.

## Tickets

### T-001 — Project bootstrap
Create/confirm:
- Next.js + TypeScript application;
- lint/format;
- test runner;
- environment configuration;
- module-oriented directory structure;
- basic CI if repository supports it.

Acceptance:
- application starts;
- typecheck/lint/tests execute;
- no domain features implemented.

### T-002 — PostgreSQL + migrations
Add local PostgreSQL development setup and migration mechanism.

Acceptance:
- clean database can be created from migrations;
- configuration comes from environment variables;
- no credentials committed.

### T-003 — Core metadata schema
Implement:
- Organization
- Workspace
- Dataset
- DatasetVersion
- DatasetColumn

Acceptance:
- relationships enforce ownership;
- IDs are generated server-side;
- timestamps available;
- dataset version status supports PROCESSING/READY/FAILED.

### T-004 — CSV upload
Implement upload endpoint/UI.

Implementation ready for review. Approved T-004 scope stops at immutable raw storage and
DatasetVersion(PROCESSING), awaiting future processing; no parser, worker, queue or lifecycle
transition is included. Local development scaffolding is not authentication, authorization or
tenant security and is disabled in production. See ADR-004 and README for setup and verification.

Acceptance:
- only supported file types accepted;
- configurable size limit;
- raw file stored immutably;
- Dataset + DatasetVersion created;
- processing begins or can be triggered.

### T-005 — DatasetVersion lifecycle
Implemented for review: internal conditional finalization API and PostgreSQL concurrency tests.
T-004 upload remains PROCESSING. No CSV processing or automatic finalization is wired in.
Terminal states cannot be changed through this API. See TDD for contracts and numbering decision.
No migration or dependency added during T-005. T-006 subsequently completed with conditions.

Acceptance:
- upload starts PROCESSING;
- successful processing becomes READY;
- parser/processing failure becomes FAILED;
- failure has safe machine-readable error code/message.

### T-006 — SP-01 DuckDB spike
Use a realistic `vendas.csv`.

Verify:
- open/read CSV;
- row count;
- schema inspection;
- preview;
- null inspection;
- `SUM(quantity * unit_price)`;
- execution time;
- compatibility with intended Node/runtime/deploy environment.

Deliverable:
- short result in `docs/spikes/SP-01-duckdb.md`;
- recommendation: ACCEPT / ACCEPT WITH CONDITIONS / REJECT.

Do not make DuckDB a permanent architectural dependency before this ticket is reviewed.

### T-007 — Persist schema/profile

Implemented for review: explicit local processing, atomic columns/counts/READY, conservative
operational failures, nullable unknown when no NULL is observed. See TDD and README.
No migration or new package; DuckDB promoted to runtime. T-008 subsequently implemented for review.
Persist detected DatasetColumn metadata and basic profile.

Suggested fields:
- physical_name
- inferred_type
- nullable
- ordinal
- null_count/null_ratio when available
- sample metadata when safe

### T-008 — Data Preview
Implemented for review: local-only dataset list/detail, persisted metadata/schema, read-only
DuckDB preview (50 rows), explicit named-cell serialization and safe integrity errors.
Real dataset verified: 20 rows / 7 columns, READY unchanged. Native compiled Next runtime
tested through the same reader in a minimal harness; real production routes remain disabled.
See docs/T-008-data-preview.md. No migrations/new dependencies. T-009 was subsequently implemented for review.

Implement the first functional product screen.

Show:
- dataset name;
- status;
- row/column count;
- table preview;
- detected types;
- warnings/errors.

States:
- EMPTY
- LOADING/PROCESSING
- READY
- FAILED

### T-009 — Ground-truth aggregation
Implemented for review: explicit local-only exact DECIMAL aggregation for the fixed EPIC-01
calculation, with versioned synthetic ground truth and independent BigInt-cent oracle.
The real READY dataset returned 2059.61 and matched the SP-01 Python Decimal reference.
No database/raw writes, migrations, dependencies, UI, Query Engine or Semantic Layer.
See docs/T-009-ground-truth-aggregation.md.

Add a fixture with known expected values.

At minimum verify:
```text
SUM(quantity * unit_price)
```

Acceptance:
- automated integration test returns the known expected value;
- test is deterministic;
- fixture is versioned.

## Definition of Done
A developer/user can:
1. upload `vendas.csv`;
2. see Dataset created;
3. see DatasetVersion progress;
4. see detected columns;
5. reopen the dataset;
6. view Data Preview;
7. execute the ground-truth aggregation;
8. receive the expected deterministic result.

## Implementation order
```text
T-001
 ↓
T-002
 ↓
T-003
 ↓
T-004
 ↓
T-005
 ↓
T-006 / SP-01
 ↓
T-007
 ↓
T-008
 ↓
T-009
```

## Epic gate
Do not begin EPIC-02 until:
- CSV pipeline is stable;
- Data Preview works;
- SP-01 is reviewed;
- ground-truth aggregation passes.

Implementation evidence for all four gates is recorded in the T-009 report. EPIC-01 remains
awaiting review; this does not approve production deployment or begin EPIC-02.
