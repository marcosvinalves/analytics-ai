# ADR-023 — VisualizationSpec & Recommendation

## Status

Accepted for EPIC-04/T-023.

## Context

Dashboard widgets need a deterministic, engine-independent presentation contract. Analytical
meaning and transformations already belong to SemanticQuery, the Semantic Layer and Query
Foundation; visualization must not calculate, aggregate, filter, order or generate SQL.

## Decision

`VisualizationSpecV1` is a closed pure-domain contract with four variants: KPI, TABLE, BAR and
LINE. Output bindings use the stable semantic identity `{ role, key }`, matching
`QueryResultColumn`. Labels, names, physical columns, output positions and SQL aliases are not
identities.

`parseVisualizationSpec(unknown)` performs exact-key and prototype-safe parsing, normalizes UUIDs
to lowercase, reconstructs and deeply freezes the result, and produces deterministic canonical
JSON metadata bounded to 4 KiB. The issue list is bounded to 16. No schema library is added.

Compatibility has two typed sources. PRE_EXECUTION derives output shape and ordering from a
`ResolvedSemanticQuery`; POST_EXECUTION takes `QueryResult.columns` as authority for effective
outputs and `QueryExplanation.orderBy` for ordering. Both phases use one private compatibility
matrix and never inspect rows.

KPI accepts exactly one numeric Metric and no dimensions. TABLE accepts every nonempty shape
already valid in Query Foundation. BAR accepts one STRING/BOOLEAN dimension and one numeric Metric.
LINE accepts one DATE/DATETIME/INSTANT dimension and one numeric Metric, with that dimension ASC as
the first ordering target. LINE V1 expresses compatibility with a future ordered categorical axis;
it performs no temporal parsing, timezone interpretation or bucketing.

`recommendVisualization(ResolvedSemanticQuery)` runs only before execution. It deterministically
recommends KPI, BAR, LINE or the universal TABLE fallback and returns a stable reason code. It does
not modify or execute the query, and the user may replace the recommendation later.

## Consequences

Visualization remains presentation-only and independent from PostgreSQL, DuckDB, React and chart
libraries. A temporal query without the required primary ASC ordering falls back to TABLE. Mapping
typed values into renderable view models remains T-024.
