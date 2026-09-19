# EPIC-01 — Data Foundation

**Status:** READY  
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

Acceptance:
- only supported file types accepted;
- configurable size limit;
- raw file stored immutably;
- Dataset + DatasetVersion created;
- processing begins or can be triggered.

### T-005 — DatasetVersion lifecycle
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
Persist detected DatasetColumn metadata and basic profile.

Suggested fields:
- physical_name
- inferred_type
- nullable
- ordinal
- null_count/null_ratio when available
- sample metadata when safe

### T-008 — Data Preview
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
