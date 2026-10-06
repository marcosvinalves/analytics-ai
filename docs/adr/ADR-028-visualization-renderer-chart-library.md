# ADR-028 — Visualization Renderer & Chart Library

## Status

Accepted for EPIC-04/T-028.

## Context

T-024 produces frozen presentation ViewModels for KPI, TABLE, BAR and LINE. INTEGER and DECIMAL
strings are authoritative and exact; NUMBER strings are authoritative but approximate. Numeric
chart values may additionally contain a finite `geometryValue`, which is only a rendering
coordinate. Rendering must not move analytical transformation into the UI or recover displayed
content from an approximate JavaScript number.

The application uses Next.js 16.3.5, React 19.3.0 and TypeScript 5.9.3. The chart choice was tested
against Recharts 3.10.1, Apache ECharts 6.1.0, Visx 4.0.0 and Nivo 0.99.0. Registry unpacked sizes,
which are package-shape indicators rather than browser bundle measurements, were approximately
7.45 MB for Recharts, 60.30 MB for ECharts, 0.33 MB for the three initially required Visx packages
and 0.71 MB for Nivo BAR + LINE before their shared/transitive packages.

ECharts was not advanced to the application harness because its framework-independent imperative
API would require local React lifecycle and resize integration. Visx was not advanced because its
low-level packages require the application to build axes, interaction, tooltip and accessibility
behavior that the Alpha does not otherwise need. Nivo supports React 19 and high-level responsive
charts, but BAR and LINE pull separate chart families and a broader shared module graph. Recharts
provided BAR, LINE, responsive sizing, custom HTML tooltips and an accessibility layer through one
React-native package surface, so it was advanced to the real runtime spike.

## Decision

Use Recharts 3.10.1 with its required `react-is` 19.3.0 peer. KPI, TABLE, wrappers and the complete
accessible chart table remain server-renderable. Only the BAR and LINE chart components establish
a Client Component boundary and import Recharts.

All user-visible values come from the authoritative value. INTEGER and DECIMAL are formatted
directly from strings, including grouping and trailing decimal zeroes. NUMBER is formatted from its
authoritative string and identified as approximate. DATE, DATETIME and INSTANT use lexical
formatting; the renderer does not create JavaScript Date objects or invent a timezone.

BAR and LINE adapters preserve input order, duplicate dimensions, NULL and every original point.
They carry both the authoritative/formatted value and `geometryValue`. Recharts receives only
`geometryValue` for scales and coordinates. Custom tooltips read the authoritative formatted value
from the original datum. NULL is represented as absent geometry and never as zero. LINE explicitly
disables connecting NULLs.

An existing authoritative value without `geometryValue` remains valid data. BAR does not create a
zero-height or artificial bar; LINE treats it as a gap. Both render a notice and retain the complete
point in `AccessibleChartTable`. This condition is distinct from NULL, an error and missing data.

BAR and LINE always include a keyboard-accessible disclosure containing a semantic HTML table
derived from the same ViewModel. The table preserves every point, order, duplicate, NULL,
authoritative value, large integer and full timestamp. Native chart accessibility improves the
experience but is evaluated together with this complete fallback.

## Spike evidence

The temporary harness imported the permanent `VisualizationRenderer` into an actual App Router
route and was removed after validation. With Node 22.23.2, Next.js 16.3.5 and React 19.3.0:

- `next build` compiled and statically generated the harness route;
- `next start` loaded both Recharts Client Components from the production artifact;
- Playwright running Edge headless observed no application or hydration error;
- BAR and LINE rendered on desktop and at a 390 × 844 mobile viewport;
- resize, keyboard focus, touch tooltip and reduced-motion mode completed;
- a custom BAR tooltip displayed authoritative `2059.6100` as `2.059,6100` while geometry used
  `2059.61`;
- NULL, duplicate categories/timestamps, a long category, an exact integer beyond
  `Number.MAX_SAFE_INTEGER`, missing geometry, LINE gaps and 500 points were exercised;
- the complete fallback exposed values without geometry and NULL independently;
- the chart-specific production chunk was 389,594 raw bytes and 111,642 gzip bytes in this
  harness. This is an observed route cost, not a general bundle guarantee for T-029.

The first harness run also found that `ResponsiveContainer` needs a definite parent height for
LINE; the permanent wrapper therefore uses a fixed `20rem` chart viewport instead of relying on
`min-height`.

## Consequences

Rendering remains downstream of `VisualizationViewModel` and has no dependency on QueryResult,
SemanticQuery, SemanticModel, Metric AST, SQL, DuckDB or raw data. Recharts is presentation-only.
The renderer does not sort, aggregate, bucket, deduplicate, truncate or interpolate.

The Alpha accepts the measured client cost for the small four-visualization set. A future route may
measure route-level splitting again, but T-028 adds no speculative dynamic loader or Next.js
configuration. The spike route, browser test and losing candidates are absent from the final tree.
