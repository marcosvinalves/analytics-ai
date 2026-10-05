# ADR-024 — Typed Visualization Mapping

## Status

Accepted for EPIC-04/T-024.

## Context

Visualization rendering needs presentation-ready shapes without moving analytical calculation out
of Query Foundation. `QueryResult` already defines authoritative typed values, while T-023 defines
the compatible output shapes for KPI, TABLE, BAR and LINE.

## Decision

`mapVisualization(spec, result, orderBy)` is a pure domain boundary. It performs the minimum
structural checks needed to consume a `QueryResult`, delegates POST compatibility to T-023, locates
bound outputs only by `{ role, key }`, and reconstructs a deeply frozen typed ViewModel. It receives
only `QueryExplanation["orderBy"]`; no other explanation metadata enters the mapper.

TABLE preserves column order, row order, semantic types and every authoritative `QueryValue`. BAR
and LINE preserve row order, duplicates and NULL points. LINE keeps DATE, DATETIME and INSTANT as
their authoritative strings and performs no date parsing, timezone conversion, sorting or
bucketing. KPI distinguishes no row (`EMPTY`), one NULL row (`VALUE` with NULL), one value row, and
invalid cardinality above one row.

INTEGER and DECIMAL strings remain exact and authoritative. NUMBER strings remain authoritative but
are marked approximate. Numeric ViewModels may also contain an optional finite `geometryValue`
derived with `Number`; it is only a rendering coordinate and must never replace labels, persistence
or analytical input. NULL is never converted to zero or removed.

The mapper adds no row, point or byte limit. Query Foundation remains responsible for result safety
caps and complete lexical validation. Mapping rejects only the structural inconsistencies required
for safe consumption and does not duplicate T-019 parsing or the T-023 compatibility matrix.

## Consequences

Future rendering can consume small typed ViewModels without PostgreSQL, DuckDB, I/O or analytical
transformation. A renderer must use authoritative values for display and may use `geometryValue`
only for geometry. Decisions about formatting, locale, gaps, axes and chart components remain later
work.
