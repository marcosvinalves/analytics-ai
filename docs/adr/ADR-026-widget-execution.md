# ADR-026 — Widget Execution

## Status

Accepted for EPIC-04/T-026.

## Decision

`executeDashboardWidget` is the server-side application boundary for one persisted widget. It
starts with the workspace-scoped T-025 read, takes `semanticModelId`, `SemanticQueryV1` and
`VisualizationSpecV1` only from that widget, calls `runSemanticQuery` exactly once and delegates
presentation mapping exclusively to `mapVisualization`.

The closed result distinguishes `SUCCESS`, `EMPTY`, `BROKEN`, `NOT_FOUND`, `ERROR` and
`CANCELLED`. SUCCESS and EMPTY preserve the mapped ViewModel and QueryExplanation but do not expose
QueryResult. EMPTY means no renderable rows or points: KPI `EMPTY`, zero TABLE rows or zero BAR/LINE
points. KPI `VALUE(NULL)` remains SUCCESS.

BROKEN is restricted to proven persisted configuration failures from T-025 and post-execution
visualization incompatibility. `QUERY_NOT_SUPPORTED` remains ERROR because the frozen Query
Foundation outcome combines semantic resolution failures with unsupported source, physical
conversion and compilation capabilities. `INVALID_RESULT` and contradictions between validated
artifacts map to `INCONSISTENT_QUERY_PIPELINE`.

The caller supplies only workspace, dashboard and widget identities plus an optional AbortSignal.
Cancellation is checked before and after the metadata read, and the same signal reaches
`runSemanticQuery`. Execution performs no metadata or raw-data writes.

## Consequences

T-026 creates no second query path or visualization compatibility matrix. It adds no persistence,
cache, long transaction, concurrency pool, endpoint or UI. Parallel executions of one widget are
independent and use the configuration each invocation observed during its scoped read. Dashboard
wide scheduling remains T-027.
