# ADR-029 — Dashboard Read-Only Consumption Experience

## Status

Accepted for EPIC-04/T-029.

## Decision

The first Dashboard consumption route is `/dashboards/[dashboardId]`. It runs on the Node runtime,
is force-dynamic and remains a Server Component. The route obtains the temporary development
workspace from `localUploadContext`, reads `name` and `description` through `getDashboard`, then
executes the Dashboard exclusively through `executeDashboard`. A later `NOT_FOUND` from execution
is terminal and discards the visual metadata read earlier.

The workspace ID is retained server-side as exposure minimization. This is not authorization. The
actual metadata isolation is provided by the existing workspace-scoped application boundaries;
the Alpha scaffold remains development-only and must be replaced by authentication and membership
authorization before production use.

The page uses a local minimal shell and a CSS Grid projection of the persisted 12-column layout.
Desktop honors `x`, `y`, `width` and `height`; tablet and mobile adapt only for consumption and do
not persist an alternative layout. A Widget without reconstructible layout appears in a separate
attention area and receives no fabricated coordinates.

Widgets do not have a persisted title. SUCCESS and EMPTY therefore use presentation context from
existing ViewModel labels; this context is not a stable Widget identity. `VisualizationRenderer`
remains the only KPI, TABLE, BAR and LINE renderer. Every other Widget outcome is mapped to safe
human text, while reason codes and infrastructure details stay out of the DOM.

Only the refresh button and native-dialog explanation drawer add new Client Component boundaries.
Refresh uses `router.refresh()` with `useTransition` and performs no mutation. The drawer consumes
only `QueryExplanation`, humanizes its closed expression vocabulary and never displays IDs, SQL,
AST, engine or storage details. Route loading represents aggregate waiting; it does not claim
per-Widget streaming.

## Consequences

The experience is read-only: it persists no execution, result, error, explanation, refresh time or
layout change. The existing local scaffold disables the route in production. The native dialog
provides modal keyboard behavior, Escape handling and focus return without a dependency. The route
adds no endpoint, Server Action, migration, authentication, editing capability or query path.

Because `loading.tsx` may start streaming before an asynchronous absence is known, a secure visual
not-found state can be returned as a streamed soft 404. Guaranteeing a later HTTP 404 would require
request interception or duplicated lookup outside the page and is deferred.
