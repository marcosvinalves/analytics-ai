# ADR-027 — Dashboard Execution

## Status

Accepted for EPIC-04/T-027.

## Decision

`executeDashboard` is the server-side application boundary for executing the Widgets initially
discovered for one workspace-scoped Dashboard. Discovery uses only `listDashboardWidgets`, whose
Dashboard-rooted query distinguishes an absent Dashboard from an empty one and returns deterministic
layout order. Every discovered Widget, including one reported as BROKEN by discovery, is executed
exclusively through `executeDashboardWidget`.

A local two-worker pool limits concurrency per invocation. Results are written to their discovery
indexes, so completion order cannot change `layout_y, layout_x, id` order. Widget outcomes are
isolated: SUCCESS, EMPTY, BROKEN, ERROR, NOT_FOUND and individual CANCELLED do not fail or cancel
siblings. An unexpected exception is reduced to that Widget's safe OPERATIONAL_FAILURE.

The Dashboard top-level is COMPLETED whenever discovery and coordination finish without observing
its supplied AbortSignal as aborted, regardless of individual outcomes. It is CANCELLED only when
that signal is observed aborted during coordination. Running Widgets receive the same signal;
workers stop claiming new Widgets, await in-flight work and mark every discovered but unstarted
Widget CANCELLED. An individual CANCELLED without a Dashboard abort leaves the top-level COMPLETED.

Each result item preserves the Widget ID, layout observed at discovery (or null when it cannot be
reconstructed) and the complete T-026 result. Creates after discovery are deferred to the next
invocation. Updates may be observed by T-026's reread. Deletes may produce NOT_FOUND or allow an
already-read execution to finish. No lock or transaction spans analytical execution.

## Consequences

Dashboard execution is synchronous, request-scoped and read-only. Independent invocations have
independent concurrency limits. T-027 adds no query path, visualization logic, persistence, cache,
retry, scheduler, migration, dependency, endpoint or UI.
