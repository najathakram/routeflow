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

## Code map routine

A signature-level **code map** lives at [`.claude/code-map/`](.claude/code-map/) (the `code-map`
skill). **Use it instead of re-reading the repo.**

- **Before reading/changing code:** read `code-map/INDEX.md` → the relevant area file
  (`api`/`web`/`mobile`/`packages`.md) → open only the file it points to. Plan changes from the map.
- **After _every_ change (surgical, not a regen):** update the touched entries (purpose,
  exports/signatures, cross-refs) and bump `_meta.json` (`mappedSha`, `generatedAt`). A small code
  change is a few-line map edit.
- Trust the code over the map when they disagree, and fix the map. Money math lives in
  `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` — keep all three mirrors in sync.

## Money discipline

All line/tax/total math goes through `pricing.ts` helpers: `computeLineSubtotal` (boxed proration),
`normalizeBoxesPieces` (integer boxes/pieces + rollover), and `roundMoney` (cents). **Round every
monetary write**; never re-derive `qty * unitPrice` for a boxed line (over-charges by `unitsPerBox`).
Regression specs: `apps/api/src/common/pricing.spec.ts`. Run `npm run verify` before pushing.

## Conventions

- **Tests**: NestJS `Test.createTestingModule`; mock at the module boundary; `class-validator` DTOs. **No snapshot tests, no Vitest.**
- **Commits**: Conventional Commits (enforced by commitlint) — `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- **Mobile mirrors web**: reuse the same API endpoints/DTOs/flows; only the UI differs.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.

## Test tenants & real-client data (POLICY — no exceptions)

Live client tenants (and their users, products, orders, and documents) are **real businesses'
production data**. They are never test targets and never examples.

- **Approved test tenants**: `test`, `e2e-routeflow`, and throwaway slugs matching `qa-*`,
  `e2e-*`, or `ux-audit-*`. ALL testing, seeding, QA, and cleanup — local **or production** —
  happens ONLY on these, with dummy retailers/buyers. Enforced in code by
  [`scripts/lib/test-tenants.cjs`](scripts/lib/test-tenants.cjs) (`assertTestTenant`); every
  tenant-scoped script/test entry point must call it before any write.
- **Never reference a live client** (slug, business name, product names, order/invoice numbers,
  tenant UUIDs) in code, tests, fixtures, UI placeholders, examples, docs, or the code map — use
  `acme`-style placeholders instead.
- **Never hardcode credentials or production connection strings** anywhere; read `DATABASE_URL`
  / `SUPER_ADMIN_*` / `PLAYWRIGHT_SA_*` from the environment. Prod DB access goes through
  `railway run --service postgres node <script>`.
- Debugging or changing a live tenant's data happens **only at the client's explicit request**,
  with a fresh backup first, and via read-only reports or dry-run-first scripts
  (`--live-tenant-override` + type-back confirmation where supported).

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

### Canonical deploy flow: **public → push/CI → merge → private** (deploy continues private)

The repo is **private by default** (commercial source). CI (public repos = free Actions) needs it
public; Railway's GitHub deploy does **not** (the Railway GitHub App clones private repos fine —
proven on #244/#245 and every batch since, incl. #318 which shipped fully private). The public
window exists ONLY to run CI, so keep it to minutes.

> **Owner authorization (2026-07-31):** the assistant IS authorized to perform the visibility
> flips as part of this routine — a brief public window for CI is an accepted trade-off. Two hard
> rules: (1) **never leave the repo public** — flip back to private even if CI fails, the merge
> fails, or anything else goes wrong (treat the private flip as a `finally`); (2) keep the public
> window minimal — flip private **immediately after the merge**, never wait for the Railway
> deploy (it clones fine while private).

1. **(schema change only)** apply the prod migration FIRST — fresh backup, then
   `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` (must precede the app deploy).
2. **Make it public** — `gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences`
3. **Push + CI green + merge the PR to master** (squash). The master push triggers Railway's auto-deploy.
4. **Make it private again, immediately** — `gh repo edit najathakram/routeflow --visibility private --accept-visibility-change-consequences`.
   Do this even if CI failed or the merge was aborted.
5. **Watch the deploy** (`railway deployment list --service @routeflow/{api,web,mobile}`) until
   SUCCESS, then `npm run post-deploy-check`.

> ⚠️ Don't `railway up` an UNMERGED branch when master will later auto-deploy: a subsequent master
> push auto-deploys master-without-your-branch and can briefly regress it (hit + fixed on
> #244/#245 — merge to master instead).
>
> **If a deploy ever fails with "Snapshot code → repository not found"**, the Railway GitHub App
> has lost private-repo access again (see memory `project_railway_deploy_outage_2026-07`). Then
> either stay public until the deploy finishes (the pre-2026-07-13 ordering) or force-deploy local
> source: `railway up --service @routeflow/api --ci` then `--service @routeflow/web --ci`.
> Permanent fix = reinstall the Railway GitHub App with private-repo access on `najathakram`.
> Docs-only changes (outside `watchPatterns` = `apps/<svc>/**` + `packages/**`) are SKIPPED by
> Railway — nothing to watch.

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
