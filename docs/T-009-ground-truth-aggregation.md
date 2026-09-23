# T-009 — Ground-truth Aggregation

Status: implemented, awaiting review. No next ticket or epic started.

Environment: Windows x64, Node 22.23.2, DuckDB engine 1.5.5 via
`@duckdb/node-api` 1.5.5-r.5, PostgreSQL 18.6 for isolated integration.
No migration or dependency was added.

## Scope and API

```ts
runGroundTruthAggregation(pool, {
  workspaceId,
  datasetVersionId,
}): Promise<GroundTruthAggregationResult>
```

The operation is deliberately specific to `SUM(quantidade * preco_unitario)`. It is not a
Query Engine, Semantic Query, Metric or reusable SQL service. The explicit administrative command is:

```sh
npm run dataset:ground-truth -- --version-id <UUID>
```

The temporary local context supplies the workspace server-side and is not authentication,
authorization or tenant security. The command is disabled in production. There is no UI or endpoint.

Results are SUCCESS, NOT_FOUND, NOT_READY(PROCESSING/FAILED), or safe ERROR with one of:
GROUND_TRUTH_SCHEMA_INVALID, GROUND_TRUTH_INPUT_INVALID, GROUND_TRUTH_OVERFLOW,
GROUND_TRUTH_READ_FAILED, GROUND_TRUTH_OPERATIONAL_FAILURE. Error responses expose no SQL,
path, stack, raw values or credentials.

SUCCESS contains exact `value: string | null`, observed `type: "DECIMAL(38,2)"`, and decimal-string
rowCount/contributingRows. No JavaScript Number transports the total.

## SQL and precision decision

The normalized header is checked first, then operand text is validated precisely, and finally every
raw value is checked against the persisted physical schema before aggregation. The calculation uses
the original CSV text; it never casts the already inferred DOUBLE value back to DECIMAL.

```sql
SELECT
  CAST(SUM(
    CAST("quantidade" AS DECIMAL(18,0)) *
    CAST("preco_unitario" AS DECIMAL(18,2))
  ) AS VARCHAR) AS total,
  typeof(CAST(0 AS DECIMAL(18,0))) AS quantity_type,
  typeof(CAST(0 AS DECIMAL(18,2))) AS price_type,
  typeof(CAST(0 AS DECIMAL(18,0)) * CAST(0 AS DECIMAL(18,2))) AS product_type,
  typeof(SUM(CAST("quantidade" AS DECIMAL(18,0)) *
             CAST("preco_unitario" AS DECIMAL(18,2)))) AS sum_type
FROM ground_truth_raw;
```

Observed in DuckDB 1.5.5:

| Expression | Effective type |
| --- | --- |
| quantity cast | DECIMAL(18,0) |
| unit price cast | DECIMAL(18,2) |
| quantity × unit price | DECIMAL(18,2) |
| SUM(product) | DECIMAL(38,2) |

The VARCHAR cast is only the serialization boundary. There is no final numeric cast or ROUND to
force agreement. The implementation verifies these runtime types and fails operationally if a
future engine changes them.

The accepted textual domain is signed integer quantity and signed plain decimal price with at most
two fractional digits. It rejects scientific notation, excess scale, fractional quantity, whitespace,
NaN/Infinity and values outside DECIMAL(18,*). The product is constrained by DuckDB's observed
DECIMAL(18,2) result; individually valid operands can still overflow multiplication, which returns
GROUND_TRUTH_OVERFLOW. This fixed rule is evidence for the ticket, not a MONEY semantic inference.

NULL in either operand excludes that row from SUM. Zero rows or no contributing pair returns null.
An actual sum of zero returns `"0.00"`. A non-NULL invalid value fails even if the other operand is NULL.

## Two independent ground truths

The versioned synthetic fixture is intentionally unrelated to the real total:

- fixture: `tests/fixtures/ground-truth/synthetic.csv`;
- expected: `tests/fixtures/ground-truth/expected.json`;
- expected value: `"17.30"`, seven rows, five contributing pairs;
- independent oracle: Node BigInt arithmetic in integer cents, without DuckDB or floating point;
- includes 0.10, 0.20, zero quantity, negative quantity, NULL quantity and NULL price.

The real T-004/T-007 dataset remained READY with 20 rows and seven persisted columns. The command returned:

```json
{"outcome":"SUCCESS","value":"2059.61","type":"DECIMAL(38,2)","rowCount":"20","contributingRows":"20"}
```

The historical expected value is `"2059.61"`. The independent Python `decimal.Decimal` oracle from
SP-01 was repeated as an external verification and returned the same value. Python remains outside
the product runtime and normal automated suite.

Before/after JSON snapshots of organizations, workspaces, datasets, dataset_versions and
dataset_columns were byte-identical. The raw SHA-256 remained
`5588ec80a695b1be608aa0a7783b82c5aa9cd54a0e9fb4a338ea027242843796`.
DatasetVersion status, timestamps and DatasetColumns were unchanged; no result was persisted.

## Security and failure behavior

The operation requires a server-controlled workspace/version relationship. Storage namespace/key
come only from PostgreSQL. Shared resolution prevents traversal and symlinks; SQL identifiers and
literals are escaped, paths are bound parameters, and the calculation/precision are constants.
No client SQL, expression, filesystem path, storage key or connector is accepted.

PROCESSING and FAILED return NOT_READY without reading the raw. Wrong workspace, absent version and
invalid identifiers return NOT_FOUND. Missing required/nonnumeric persisted columns return schema
error. Missing raw, structural/header mismatch or disagreement with the persisted physical schema
return read error. Lexically invalid operands return input error. Numeric/product overflow returns
overflow. All keep READY and metadata/raw intact; none invokes lifecycle or retries automatically.

## Verification and EPIC-01 gate

- Unit suite: 105 tests passed, including the synthetic independent oracle and previous checks.
- PostgreSQL integration: clean database, lifecycle states, workspace isolation, required columns,
  exact decimals, NULL, empty input, zero, negatives, invalid syntax, scale, overflow, raw/schema
  mismatch, snapshots and hashes; 123 tests passed in the final full run.
- Preview E2E: 3 passed. Upload E2E: 3 passed.
- Production build and compiled Next/DuckDB runtime passed.

EPIC-01 gate assessment:

1. CSV pipeline stable: T-004/T-005/T-007 checks pass; immutable raw and lifecycle invariants retained.
2. Data Preview functional: T-008 E2E passes on the real READY dataset.
3. SP-01 reviewed: ACCEPT WITH CONDITIONS; native Windows/Node and compiled Next paths verified.
4. Ground truth correct: synthetic `17.30` matches BigInt cents; real `2059.61` matches Python Decimal.

On passing the final regression run, EPIC-01 is technically complete for the reviewed Technical Alpha
scope, awaiting user review. This does not certify production or start the next epic.

## Files and remaining conditions

Created: domain/application/infrastructure ground-truth modules, explicit local command, shared
concrete DuckDB/CSV helper, synthetic fixture/expected, unit/integration tests, and this report.
Modified: package script, metadata reader, preview reader (shared concrete helper), README, TDD and epic.

Known conditions remain: local filesystem/operator trust, 10 MiB Alpha input limit, two DuckDB threads
and 256 MB engine memory are not process isolation; aggregation scans the whole raw and fingerprints
add full-file reads. No timeout/cancellation/load certification. No persisted historical checksum.
Linux, ARM, containers, serverless, standalone tracing and deploy target remain unverified.
