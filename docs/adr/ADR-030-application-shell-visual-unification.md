# ADR-030 — Application Shell & Visual Unification

## Status

Accepted for T-029.1 and the EPIC-04 closure.

## Decision

The App Router root layout owns the single global `AppShell`. Its server-rendered top bar,
content landmark and responsive geometry wrap every product route. `PrimaryNavigation` is the
only shell Client Component because active destination state depends on `usePathname`; it exposes
Inicio, Dados and Dashboards after those destinations exist.

Pages compose the shared `PageContainer`, `PageHeader`, `ActionLink`, `EmptyState`, status and
notice primitives. Product routes do not create nested application shells or additional `main`
landmarks. Global design tokens define color, spacing, borders, radius, shadow, focus and reduced
motion behavior; route CSS remains local to its content.

`/dashboards` is the read-only discovery entry point. It resolves the temporary server-controlled
development Workspace and reuses `listDashboards`; it does not execute Widgets or analytical
queries. `/dashboards/[dashboardId]` retains the T-029 execution pipeline and the same navigation
destination remains active for both routes.

## Consequences

Loading, error and not-found states render inside one stable shell. Desktop, tablet and mobile
share navigation and content geometry without persisting viewport-specific layout. The Technical
Alpha gains a functional route to discover existing Dashboards but no authoring, fake creation
action, cache, endpoint, migration or dependency.

The local Workspace context remains development scaffolding, not authentication or authorization.
Production membership and tenant resolution stay deferred.
