# ADR-022 — Dashboard Domain & Persistence

## Status

Accepted for EPIC-04/T-022.

## Context

The Technical Alpha needs a persistent workspace-owned Dashboard identity before widgets,
semantic queries, visualization specifications or layout exist. PostgreSQL remains the metadata
store, and all internal access must include the server-controlled Workspace scope.

## Decision

Create `app.dashboards` with a PostgreSQL-generated UUID, mandatory Workspace FK, case-sensitive
`UNIQUE(workspace_id, name)`, optional nonblank description and timezone-safe timestamps. Input
rejects leading or trailing whitespace instead of normalizing it. The existing
`app.set_updated_at()` trigger maintains `updated_at`.

CRUD uses one PostgreSQL statement per operation under autocommit. Reads and mutations always
include `workspaceId`; a missing resource and a resource in another Workspace both return
`NOT_FOUND`. Concurrent metadata updates use last-write-wins. No version, ETag or optimistic lock
is introduced. As an Alpha simplification, every accepted UPDATE may advance `updated_at`, even
when name and description equal their current values.

Unexpected create failure after the statement may have been sent returns `OUTCOME_UNKNOWN`.
Update and delete intentionally collapse unexpected failures to `OPERATIONAL_FAILURE`. There is no
exactly-once or reconciliation framework.

## Consequences

Names differing only by case remain distinct. Dashboard creation with the same exact name is
serialized by the unique constraint. Workspace deletion and ID updates are blocked by
`ON DELETE/UPDATE RESTRICT`. This ticket adds no DashboardWidget, query execution, HTTP boundary,
UI, authorization or dependency.
