# RecoverAI

RecoverAI is a synthetic fintech command center that explains and applies autonomous revenue-recovery decisions to failed payments.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/recoverai/src/App.tsx` — responsive dashboard routes, charts, tables, drawers, and user interactions.
- `artifacts/recoverai/src/index.css` — RecoverAI theme tokens, typography, motion, and layout utilities.
- `artifacts/api-server/src/routes/recoverai.ts` — deterministic synthetic transaction generator, recovery engine, JSON persistence, and API routes.
- `lib/api-spec/openapi.yaml` — source of truth for the dashboard API and generated client hooks.

## Architecture decisions

- The demo uses a local JSON store instead of payment providers or live customer data; all records are synthetic and safe to reset.
- Recovery decisions are deterministic so a competition demo produces repeatable outcomes and can visibly show guardrail changes.
- The shared API server owns transaction state, agent runs, guardrail policy, and audit history; the React client consumes generated hooks.

## Product

- Overview KPIs and Recharts visualizations for revenue at risk, recoverable value, recovered value, outcomes, failure reasons, and action mix.
- Recovery Agent page with run/reset controls, explainable score-to-action flow, and agent status.
- Transactions and Audit Log pages with search, filters, sorting, pagination, CSV export, and detail drawers.
- Guardrail Studio with persisted policy settings that influence eligibility, escalation, cooldown actions, and outcomes.
- Settings page that clearly communicates synthetic-only mode and disabled payment execution.

## User preferences

No additional preferences recorded.

## Gotchas

- The demo intentionally never calls real payment APIs.
- The frontend artifact build needs workflow-provided `PORT` and `BASE_PATH`; use the managed web workflow for previews.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
