# AGENTS.md — Project Instructions

## Product
We are building a B2B analytics platform assisted by AI.

Core flow:

Data → Semantic Layer → Metrics → Query Engine → Dashboards / Ask → Explainability

The product is not a Power BI/Qlik clone. The initial goal is to reduce Time-to-First-Insight while keeping analytics deterministic, governed and explainable.

## Core architectural rule
AI is NOT the source of truth.

AI may interpret, suggest, classify and explain. The Semantic Layer defines business meaning. The Query Engine performs calculations.

Never implement:

User → LLM → arbitrary SQL → Database

Preferred architecture:

User question → Structured Intent → Semantic Query → Validator → Query Compiler → Query Engine → Result → Explanation

## Architecture
Use a modular monolith. Main domains:
- auth
- tenant
- dataset
- semantic
- metrics
- query
- dashboard
- ai

Do not introduce microservices unless explicitly requested.

## Current technical direction
- Frontend/web: Next.js + React + TypeScript (candidate; confirm during implementation)
- Metadata: PostgreSQL
- Analytical engine: DuckDB candidate; do not treat as final until SP-01
- File storage: object storage abstraction; local storage is acceptable for development
- AI: provider abstraction + structured output + server-side semantic validation

## Security
- Every protected resource belongs to an organization/workspace.
- Authorization is enforced server-side.
- Never trust tenant/workspace identifiers from the client without membership validation.
- Never expose secrets or connector credentials.
- Never execute arbitrary SQL produced by an LLM.
- Minimize data sent to external AI providers.

## Engineering principles
Prefer simple solutions, typed contracts, small modules, deterministic behavior, explicit errors and testable business logic.

Avoid premature abstractions, microservices, unnecessary dependencies, duplicated business logic and giant service files.

Before adding a dependency, explain why it is needed.

## Testing
Critical analytics logic must have automated tests, especially:
- Metric AST
- Semantic Query validation
- Query compilation
- tenant isolation
- dataset parsing

Use ground-truth datasets for analytical tests.

## Current stage
Technical Alpha.

Current focus: `EPIC-01 — Data Foundation`.

Do not implement future roadmap features unless explicitly requested.

## Source documents
- Product: `docs/PRD.md`
- Technical design: `docs/TDD.md`
- Current epic: `tasks/EPIC-01-data-foundation.md`

## Agent workflow
For each ticket:
1. Read this file and the relevant docs/task.
2. Inspect the repository before editing.
3. State a short implementation plan.
4. Work only on the requested ticket.
5. Run relevant tests/checks.
6. Report files changed, tests run, failures and remaining risks.
7. Do not automatically start the next ticket.
