# EPIC-04 — Dashboards & Visualization

## Status

Completed through T-030 for the Technical Alpha.

## Delivered tickets

- T-022: workspace-scoped Dashboard domain and PostgreSQL persistence.
- T-023: deterministic `VisualizationSpecV1` and recommendation matrix.
- T-024: typed mapping from `QueryResult` to immutable visualization ViewModels.
- T-025: Widget/query/spec/layout persistence, maximum 12 and overlap protection.
- T-026: one-Widget execution through the existing Query Foundation.
- T-027: ordered Dashboard execution with two local workers and failure isolation.
- T-028: KPI, TABLE, BAR and LINE renderer; Recharts only for chart geometry.
- T-029: read-only Dashboard route, responsive layout and QueryExplanation drawer.
- T-029.1: global AppShell, navigation, primitives and visual unification.
- T-030: Dashboard discovery, test isolation, final browser proof and documentation closure.

## Final vertical architecture

```text
Dataset/raw
→ published Semantic Model
→ Semantic Query
→ validation/resolution/planning/compiler
→ DuckDB
→ typed QueryResult + QueryExplanation
→ VisualizationViewModel
→ KPI / TABLE / BAR / LINE
→ Dashboard execution
→ /dashboards discovery and /dashboards/[dashboardId]
→ browser
```

There is one analytical engine path. Dashboard and visualization modules do not calculate metrics,
compile SQL or read raw files directly.

## Frozen Alpha decisions

- Dashboard is a Workspace-owned aggregate root; every operation is workspace-scoped.
- Discovery displays only persisted name and optional description and performs no analytical work.
- Widgets persist SemanticQuery/VisualizationSpec JSONB and a 12-column layout.
- Mutations lock the Dashboard, allow at most 12 Widgets and reject overlap.
- KPI, TABLE, BAR and LINE are the complete visualization matrix for this epic.
- INTEGER and DECIMAL authoritative values remain strings; NUMBER is approximate.
- NULL remains distinct from zero; chart geometry never reconstructs display values.
- QueryExplanation is built from the same resolved query and result as execution.
- Execution is read-only, bounded and locally limited to two concurrent Widgets per Dashboard.
- Desktop projects 12 columns, tablet six columns and mobile stacks cards without persistence.
- The root layout owns one AppShell; PrimaryNavigation is its only client boundary.
- Destructive tests accept only loopback PostgreSQL 18.6/5433 disposable `*_test` databases.
- Browser fixtures use isolated raw storage and prove metadata/raw immutability.

## Deferred

Dashboard/Widget authoring UI, drag-and-drop, resize, builders, templates, auto-dashboard, Ask/AI,
LLM, Semantic Model UI, sharing, export, alerts, cache, scheduler, polling, realtime,
authentication, membership, RLS and mobile authoring remain outside EPIC-04.

## EPIC-05 readiness gate

EPIC-05 may reuse the single Semantic Query and Query Foundation pipeline only after T-030's full
regression, metadata/raw invariance, documentation and disposable-database cleanup are green. It
must not introduce arbitrary SQL or a second analytical engine.
