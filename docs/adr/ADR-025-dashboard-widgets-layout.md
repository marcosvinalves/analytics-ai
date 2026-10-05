# ADR-025 — Dashboard Widgets & Layout Persistence

**Status:** Accepted during T-025  
**Date:** 2026-10-05

## Decision

Persist widgets in `app.dashboard_widgets`. A Dashboard remains the aggregate root. Every mutation
locks its workspace-scoped Dashboard row with `SELECT ... FOR UPDATE` before checking the maximum
of 12 widgets, rectangular overlap in the 12-column grid and SemanticModel ownership. This one
parent lock serializes the aggregate without an exclusion constraint, lock framework or automatic
repositioning.

`semantic_model_id` is authoritative; no revision ID is stored. `semantic_query` and
`visualization_spec` are canonical JSONB and are structurally parsed both before writing and after
reading. Saving does not require a published revision, semantic compatibility, query execution or
preview. Updates replace the complete configuration and use last-write-wins.

Every operation requires `workspaceId` and `dashboardId`. A SemanticModel is accepted only when its
Dataset belongs to the same Workspace. Dashboard deletion cascades to widgets; deletion or key
change of a referenced SemanticModel is restricted.

Reads also verify individual layout bounds, Widget-to-Dashboard-to-Workspace scope and
SemanticModel ownership. A recoverable invalid widget is returned as `BROKEN` with identifiers,
safe relational metadata and a fixed reason; its corrupt JSON is never exposed. List reconstruction
is isolated per widget, so one broken configuration does not hide valid siblings. If essential
identity or timestamp metadata cannot be recovered safely, the operation returns
`INCONSISTENT_PERSISTED_DATA` rather than inventing a domain object. Reads intentionally do not
audit aggregate-wide overlap or repair data.

## Consequences

Application writes preserve the aggregate invariants under a PostgreSQL row lock. Direct SQL can
still violate the aggregate count, overlap or cross-workspace SemanticModel rule; read-side checks
surface the latter safely. These are application invariants until measured needs justify stronger
database machinery. No DuckDB, query execution, endpoint, UI or rendering dependency enters T-025.
