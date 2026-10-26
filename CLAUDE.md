# RouteFlow

Multi-tenant delivery / route-management SaaS. **npm + Turbo monorepo**: NestJS API, Next.js web, Expo mobile; deployed to Railway.

> Full original text (rationale, history, runbooks) is in [`docs/runbooks/claude-md-details.md`](docs/runbooks/claude-md-details.md); section names below are its headings.
> Read [`CLAUDE_SESSION_PREAMBLE.md`](CLAUDE_SESSION_PREAMBLE.md) before any DB/backend work (production-safety checklist, destructive scripts).

## Tech Stack

- npm workspaces (`apps/*`, `packages/*`) + **Turbo**; npm 10.8, Node >= 18 (CI 20).
- **API** `apps/api`: NestJS 11, Prisma 7 + Postgres, Redis (Socket.io), Passport JWT. Jest `*.spec.ts`.
- **Web** `apps/web`: Next.js 14 App Router, golden reference for flows/DTOs. Radix + Tailwind, TanStack Query, RHF + zod. Jest+RTL `*.test.tsx`, Playwright `e2e/*.spec.ts`.
- **Mobile** `apps/mobile`: Expo 55 / RN 0.83, expo-router, multi-role. Jest pure-logic `__tests__/*.test.ts`.
- **Shared** `packages/*`: `types`, `ui`, `pricing`, configs.
- ESLint flat config per workspace (lint via `npm run lint`) + Prettier. Deploy: Railway Docker.

## Run Commands (repo root)

| Command                   | What it does                              |
| ------------------------- | ----------------------------------------- |
| `npm run dev`             | `turbo run dev`, all apps                 |
| `npm run build`           | `turbo run build`                         |
| `npm run lint`            | eslint per workspace                      |
| `npm run check-types`     | `tsc --noEmit` per workspace              |
| `npm run test`            | Jest (api, web, mobile)                   |
| `npm run test:e2e`        | Playwright (web)                          |
| `npm run format`          | Prettier write                            |
| `npm run db:up` / `:down` | docker-compose Postgres + Redis           |
| `npm run verify`          | check-types/lint/test; run before pushing |

API runs from compiled `dist` (`nest build`, `node dist/main.js`; `nest start --watch` broken), `:3000`, prefix `/api/v1`, health `/api/v1/health`. Web `:3001`. Mobile `expo start`.

## Local hosting (pre-PR gate; no staging, `master` deploys to Railway)

Run in order: `npm run local:up` -> `local:seed` -> `local:validate` (the gate) -> `local:e2e` (UI changes). Also `local:validate:features`, `local:drift`, `local:test:db`, `local:migrate`, `local:logs`, `local:down`, `local:reset` (wipes volumes), `janitor`/`janitor:apply` (disk). Details: details doc, `docs/adr/0001-local-hosting-environment.md`, `apps/web/e2e/LOCAL-LANE.md`, `docs/runbooks/disk-cleanup-janitor.md`.

- `local:validate` runs ONLY against the `test` tenant (`SMOKE_TENANT_SLUG=test`, `assertTestTenant`).
- Compose secrets are local throwaways: never reuse them, never add prod connection strings or client identifiers.
- `web` API URL is baked at build time (rebuild to change).

## Architecture (`apps/api/src/*`, everything tenant-scoped; JWT carries `tenantId`/`role`)

Modules: tenancy/identity, domain (customers, orders, routes, products, inventory...), finance (invoices, credit-notes, vendor-bills, estimates, billing...), platform (uploads, notifications, email, audit, import...). Full list: details doc, Architecture section.

## Routines

- **Code map** `.claude/code-map/`: read `INDEX.md` -> area file -> only the pointed file. Map updates land in the docs-only follow-up PR; code PR HEAD carries `Bookkeeping-Follow-Up: pending` (Gate 2, `.claude/hooks/stop.mjs`). Trust code over map.
- **Lessons** `.claude/lessons/LESSONS.md`: read before major tasks/fixes, cite ids (`L-016`). After every bug fix write an entry (Symptom / Root cause / Lesson / Guard) + `_meta.json` bump in the follow-up PR; Gate 3 blocks `fix/*` unless the pending trailer is present. No lesson: bump `updatedAt` only. Caps 52 entries / 65,536 bytes; no client identifiers.

## Money discipline

- All line/tax/total math lives in `packages/pricing` (`@routeflow/pricing`); api, web, mobile and root scripts import it, no mirrors. Helpers: `computeLineSubtotal` (boxed proration), `normalizeBoxesPieces`, `roundMoney`. **Round every monetary write**; never re-derive `qty * unitPrice` for a boxed line.- **Entitlement gates**: every `@RequireAddon` key is declared in `apps/api/src/billing/addon-gate-registry.ts`; a new gate ships `dark` and flips to `enforced` only in a separate diff after the owner runs `apps/api/scripts/report-addon-gate-blast-radius.mjs` against prod. A new `@RequirePlanFlag` flag ships inside `DARK_PLAN_FLAGS` (`apps/api/src/billing/plan-flag.guard.ts`) until the same evidence exists; remove `DARK_PLAN_FLAGS` / `PLAN_FLAG_ENFORCEMENT` only after a plan-flag registry lands.
- Customer-level order merges serialize through `withAdvisoryLock` (`apps/api/src/common/db-locks.ts`, cross-replica). **Never add a second in-process lock**, never thread a transaction into `updateOrderItems`.
- Scheduled jobs use **`@LeaderCron(expr, "<area>.<method>")`** (`apps/api/src/common/cron-lock.ts`). **Never write a bare `@Cron(`** (`no-bare-cron.spec.ts` fails the build).

## Conventions

- Tests: `Test.createTestingModule`, mock at module boundary, `class-validator` DTOs. **No snapshot tests.**
- Commits: Conventional Commits (commitlint): `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- Mobile mirrors web: same endpoints/DTOs/flows, only UI differs.
- Shared DTOs/enums identical between web and mobile live in `packages/types/api/*.ts` (`@routeflow/types`); never redeclare. Prisma-enum mirrors live in `packages/types/api/enums.ts` (one `X_VALUES` const + derived type per enum), pinned to `@prisma/client` by `apps/api/src/common/enum-parity.spec.ts`; never hand-type a local mirror (L-072).
- Prettier: semicolons, double quotes, `printWidth` 100, trailing commas.

## Test tenants & real-client data (POLICY, no exceptions)

- Approved test tenants: `test`, `e2e-routeflow`, `routeflow-demo`, and `qa-*`, `e2e-*`, `ux-audit-*`. ALL testing, seeding, QA, cleanup (local or prod) only there, with dummy data. Enforced by `scripts/lib/test-tenants.cjs` (`assertTestTenant`); every tenant-scoped script/test entry point must call it before any write.
- `routeflow-demo` is the sales-demo tenant (synthetic data); reseed with `apps/api/scripts/demo-seed.js`. Never demo on a live client tenant.
- **Never reference a live client** (slug, name, products, order/invoice numbers, tenant UUIDs) in code, tests, fixtures, UI, examples, docs, or the code map; use `acme` placeholders.
- **Never hardcode credentials or prod connection strings**; read `DATABASE_URL` / `SUPER_ADMIN_*` / `PLAYWRIGHT_SA_*` from env. Prod DB access: `railway run --service postgres node <script>`.
- Touching a live tenant only at the client's explicit request, fresh backup first, read-only or dry-run-first scripts (`--live-tenant-override` + type-back confirmation).

## DO NOT introduce

Vitest, Biome, Supabase, Vercel, a second HTTP client, a root-level test runner or root ESLint config. Use Jest + Playwright, ESLint + Prettier, Prisma/Postgres, Railway.

## Env vars: names only, never commit values; see each app's `.env.example`. JWT secrets required in every env.

## Deployment & DB safety (Railway)

- Docker `CMD` is only `node dist/main.js`; **never auto-migrate on deploy**. **Never** `--force-reset`; **never** run destructive scripts listed in `CLAUDE_SESSION_PREAMBLE.md`; seed additively.
- **Prisma schema is a FOLDER**: `apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma` via `prisma.config.ts`. Add a model to its domain file **and** to `MODEL_DOMAIN` in `apps/api/scripts/split-prisma-schema.mjs`; `node apps/api/scripts/split-prisma-schema.mjs --check` fails on unmapped models (no "misc" bucket). Do not run `--check --from-ref e39bf9db` expecting green. Standing lossless guard = drift gate.
- Prod schema changes ONLY via `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`; locally `npx prisma migrate dev` against compose.
- Destructive migrations blocked by Squawk (`npm run lint:migrations`); whitelist with `-- reason:` + `-- squawk-ignore <rule>`.
- No boot-time DDL (grep must cover `$executeRaw`, `$executeRawUnsafe`/`$queryRaw*`, `.query(`). Drift gate `npm run db:drift -w apps/api` (exit 0 = none); any schema PR runs `railway run --service postgres node apps/api/scripts/schema-drift.mjs` against prod after deploy and needs exit 0. `SCHEMA_DRIFT_PRISMA_CLI` is test-only.
- CI audit via `scripts/ci-audit-critical.mjs` (critical only).

### Deploy flow: public -> push/CI -> merge -> private (owner-authorized 2026-07-31)

1. Schema change: fresh backup, then `prod-migrate.mjs` first.
2. Start `scripts/visibility-watchdog.mjs` detached FIRST (45 min), then `gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences`.
3. Push, CI green, squash-merge to master (Railway auto-deploys); open the docs-only bookkeeping PR in the same window.
4. Wait until BOTH deployments are `SUCCESS` (never flip on `BUILDING`), then flip private in a `finally` and confirm `PRIVATE`.
5. Watch deploy, then `npm run post-deploy-check` (E2E self-fires; do not dispatch).

Never `railway up` an unmerged branch. "Snapshot code -> repository not found": stay public until deploy finishes or `railway up --service @routeflow/api --ci` then `@routeflow/web`. Full: `docs/runbooks/deploy-visibility-flip.md`.

## Heavy files policy

No images, videos, or office binaries in git (exception: `apps/mobile/assets/` icons; `apps/web/public/brand/`, `public/marketing/`, `fonts/` build assets, total <= 476 KB). Machine-local home `local-assets/` (gitignored); generated docs/screenshots never into `docs/`. Never commit `.claude/settings.local.json`.

## Token budget & session startup

grep before reading whole files; targeted `Edit` for files > 50 lines; bullet-plan changes spanning > 3 files; one task per session. Startup: `git status && git log --oneline -5`, `npm run check-types`. `SKIP_VERIFY=1` needs `SKIP_VERIFY_REASON="<why>"` for pushes touching `apps/`, `packages/`, `scripts/`, `.github/` (audited in `.git/skip-verify.log`; docs-only exempt).
