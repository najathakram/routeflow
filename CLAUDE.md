# RouteFlow

Multi-tenant delivery / route-management SaaS. **npm + Turbo monorepo** — a NestJS API, a
Next.js web dashboard, and an Expo (React Native) multi-role mobile app, deployed to Railway.

> Production-safety checklist (migrations, destructive scripts) lives in
> [`CLAUDE_SESSION_PREAMBLE.md`](CLAUDE_SESSION_PREAMBLE.md) — read it before any DB/backend work.

## Tech Stack

- **Monorepo**: npm workspaces (`apps/*`, `packages/*`) orchestrated by **Turbo**. Package manager **npm 10.8** (Node ≥ 18, CI pins 20).
- **API** (`apps/api`): NestJS 11, Prisma 7 + PostgreSQL, Redis (Socket.io), Passport JWT auth. Tests: **Jest** (`*.spec.ts`).
- **Web** (`apps/web`): Next.js 14 App Router — the **golden reference** for flows/DTOs. Radix + Tailwind, TanStack Query, Zustand, react-hook-form + zod. Tests: **Playwright** (`e2e/*.spec.ts`).
- **Mobile** (`apps/mobile`): Expo 55 / RN 0.83, expo-router, multi-role (`(auth)`,`(customer)`,`(driver)`,`(operator)`,`(tenant)`). Tests: **Jest** (`__tests__/*.test.ts`, pure-logic only).
- **Shared** (`packages/*`): `types`, `ui`, `eslint-config`, `config`, `typescript-config`.
- **Lint/format**: ESLint **flat config** (per-workspace) + **Prettier** (root `prettier.config.js`).
- **Deploy**: Railway via Docker (per-app `Dockerfile` + `railway.toml`).

## Run Commands (from repo root)

| Command                   | What it does                                           |
| ------------------------- | ------------------------------------------------------ |
| `npm run dev`             | `turbo run dev` — all apps in watch mode               |
| `npm run build`           | `turbo run build`                                      |
| `npm run lint`            | `turbo run lint` — eslint **per workspace**            |
| `npm run check-types`     | `turbo run check-types` — `tsc --noEmit` per workspace |
| `npm run test`            | `turbo run test` — Jest (api, mobile)                  |
| `npm run test:e2e`        | `turbo run test:e2e` — Playwright (web)                |
| `npm run format`          | Prettier write across the repo                         |
| `npm run db:up` / `:down` | docker-compose Postgres + Redis for local dev          |

**ESLint runs per-workspace only** (no root `eslint.config`); always lint via `npm run lint`
or inside a workspace — `eslint` from the repo root will not resolve a config.

### Per-app notes

- **API runs from compiled `dist`**: `nest build` then `node dist/main.js`. `nest start --watch` is broken by TS errors under `scripts/` (already excluded in `tsconfig.build.json`). Listens on `:3000`, global prefix `/api/v1`. Health: `GET /api/v1/health`.
- **Web**: `next dev` on `:3001`.
- **Mobile**: `expo start`.

## Architecture (API feature modules → `apps/api/src/*`)

- Tenancy/identity: `tenant`, `tenants`, `auth`, `users`, `platform-admin` — **everything is tenant-scoped**; JWT payload carries `tenantId`/`role`.
- Domain: `customers`, `drivers`, `products`, `suppliers`, `orders`, `order-templates`, `routes`, `route-optimization`, `returns`, `inventory`.
- Finance: `invoices`, `credit-notes`, `vendor-bills`, `estimates`, `recurring-invoices`, `bookkeeping`, `billing`.
- Platform: `uploads`/`storage`, `notifications`/`messages`, `email`, `analytics`, `audit`, `import`, `config`/`system-config`.

## Conventions

- **Tests**: NestJS `Test.createTestingModule`; mock at the module boundary; `class-validator` DTOs. **No snapshot tests, no Vitest.**
- **Commits**: Conventional Commits (enforced by commitlint) — `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- **Mobile mirrors web**: reuse the same API endpoints/DTOs/flows; only the UI differs.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.

## DO NOT introduce

Vitest · Biome · Supabase · Vercel · a second HTTP client · a root-level test runner or root ESLint config.
Use what's here: **Jest + Playwright**, **ESLint + Prettier**, **Prisma/Postgres**, **Railway**.

## Environment Variables

Names only — see each app's example file. Never commit values.

- API → [`apps/api/.env.example`](apps/api/.env.example) (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, R2/Stripe/Google keys, `PORT`, `CORS_ORIGINS` …). JWT secrets are **required in every env**.
- Web → [`apps/web/.env.example`](apps/web/.env.example) (`NEXT_PUBLIC_API_URL`, `COOKIE_SECRET`, `DEFAULT_TENANT` …).
- Mobile → [`apps/mobile/.env.example`](apps/mobile/.env.example) (`EXPO_PUBLIC_API_URL` …).

## Deployment & DB safety (Railway)

- Docker `CMD` is **only** `node dist/main.js` — **never** auto-migrate on deploy.
- Schema changes apply to prod **only** via `railway run npx prisma migrate deploy`; locally `npx prisma migrate dev` against docker-compose.
- **Never** `--force-reset`; **never** run the destructive scripts listed in `CLAUDE_SESSION_PREAMBLE.md`; seed additively.

## Token Budget

- grep before reading whole files; read exports/signatures before bodies.
- Targeted `Edit` for files > 50 lines; bullet-plan changes spanning > 3 files.
- One task per session; `/compact` at checkpoints, `/clear` when switching tasks.

## Session Startup

```bash
git status && git log --oneline -5
npm run check-types
npx jest --selectProjects api --listTests >/dev/null 2>&1 || true  # confirm Jest resolves
```
