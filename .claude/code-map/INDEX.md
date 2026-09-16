# Code Map — RouteFlow

> Signature-level index of this repo. **Read this first; open only the files it points to.**
> Last reconciled: see [`_meta.json`](_meta.json) `mappedSha`. Maintained by the `code-map`
> skill — update it surgically after changes; trust the code over the map when they disagree.

## Stack & shape

Multi-tenant delivery / route-management SaaS. **npm workspaces + Turbo** monorepo.

- **API** — [`apps/api`](api.md): NestJS 11, Prisma 7 + PostgreSQL, Redis (Socket.io), JWT auth.
  Everything tenant-scoped. Jest specs.
- **Web** — [`apps/web`](web.md): Next.js 14 App Router. The **golden reference** for
  flows/DTOs. Radix + Tailwind, TanStack Query, RHF + zod. Playwright e2e + Jest/RTL unit tests.
- **Mobile** — [`apps/mobile`](mobile.md): Expo 55 / RN 0.83, expo-router, multi-role. Mirrors
  web's API/DTOs/flows; only UI differs. Jest (pure-logic).
- **Packages** — [`packages`](packages.md): `types`, `ui`, `config`, `eslint-config`,
  `typescript-config`.
- **Deploy**: Railway via per-app Docker. `CMD = node dist/main.js` only — never auto-migrate.

## Entry points

- **api** → `apps/api/src/main.ts` — boots Nest on `:3000`, global prefix `/api/v1`, health
  `GET /api/v1/health`. Runs from compiled `dist/main.js` (watch mode is broken).
- **web** → `apps/web/app/layout.tsx` (+ `app/providers.tsx`) — `next dev` on `:3001`.
- **mobile** → `apps/mobile/app/_layout.tsx` — `expo start`. Deep-link scheme `routeflow://`.

## Build / test / run (from repo root)

| Action      | Command                                        |
| ----------- | ---------------------------------------------- |
| dev (all)   | `npm run dev`                                  |
| build       | `npm run build`                                |
| typecheck   | `npm run check-types`                          |
| lint        | `npm run lint` (per-workspace; no root config) |
| test        | `npm run test` (Jest: api, mobile, web)        |
| e2e         | `npm run test:e2e` (Playwright: web)           |
| format      | `npm run format`                               |
| db up/down  | `npm run db:up` / `npm run db:down`            |
| api rebuild | `cd apps/api && npx nest build`                |

## Where to find (global — cross-area greatest hits)

Every row here is a pointer, not a description — open the linked file for the real content.

| Need / symptom                                                 | Start at                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tenant isolation engine                                        | [`api`](api.md) → `src/prisma/prisma.service.ts` `forTenant()`                                               |
| Global guard wiring (Throttler/Tenant)                         | [`api`](api.md) → `src/app.module.ts`                                                                        |
| Startup, CORS, helmet, secrets                                 | [`api`](api.md) → `src/main.ts` `assertSecrets()`                                                            |
| Env config & secret derivation                                 | [`api`](api.md) → `src/config/configuration.ts`                                                              |
| Auth (server)                                                  | [`api`](api.md) → `src/auth/`                                                                                |
| Auth (web client, tokens, tenant cookie)                       | [`web`](web.md) → `lib/api-client.ts`, `lib/auth.ts`, `lib/tenant-cookie.ts`                                 |
| Auth (mobile, SecureStore)                                     | [`mobile`](mobile.md) → `lib/api-client.ts`, `lib/auth.ts`                                                   |
| A domain end-to-end (e.g. invoices)                            | api `src/invoices/` → web `app/(dashboard)/invoices/` → mobile `lib/api/invoices.ts`                         |
| Money / line totals (round, boxed)                             | [`packages`](packages.md) → `pricing` (`computeLineSubtotal`/`normalizeBoxesPieces`/`roundMoney`)            |
| Invoice↔Order sync (both directions)                           | api `invoices.service.ts` `reconcileOrderDraftInvoice` (fwd) + `recomputeOrderFromInvoices` (back)           |
| MSRP / suggested retail on invoices                            | in-flight branch, NOT on master — see `api/where-to-find.md`                                                 |
| Duplicate purchase-invoice detection                           | [`api`](api/feature-modules-6.md) → `import/duplicate-match.service.ts`                                      |
| Supplier-statement reconciliation (AI)                         | [`api`](api/feature-modules-5.md) → `src/supplier-statements/`                                               |
| Backdating an order (business date)                            | api `orders.service.ts` `parseOrderDate` (staff-only)                                                        |
| Sales agents & commissions (flag-gated)                        | [`api`](api/feature-modules-6.md) → `src/sales-agents/` (dark until `SALES_AGENTS` addon)                    |
| Lite invite-only plan / newly-enforced plan flags (2026-09-15) | [`api`](api/lite-plan.md) — cross-cutting, split out of `feature-modules-4.md`'s cap                         |
| "When did the money land" on a payment                         | api `InvoicePayment.settledAt` vs `paidAt`; `bookkeeping.service.ts` `settledDateFilter`                     |
| Mobile scan-to-order (split view)                              | mobile `ScanOrderSheet.tsx` + `ScanTray.tsx` + `lib/scan-tray.ts`                                            |
| Smoke / pre-push verify                                        | `npm run verify`/`smoke`/`post-deploy-check`; `smoke-check` skill                                            |
| Root tooling, campaign infra, bug registry, Plane harness      | [`api`](api/root-tooling-campaign-infrastructure.md)                                                         |
| Production data-integrity forensics                            | [`api`](api/root-tooling-campaign-infrastructure.md) → `data-integrity-report.mjs` + `repair-integrity.mjs`  |
| Test-tenant policy guard (allowlist)                           | `scripts/lib/test-tenants.cjs` `assertTestTenant`; policy in CLAUDE.md                                       |
| E2E Playwright                                                 | `apps/web/e2e/` — 6 spec files; `06-critical-paths.spec.ts` = money-math guard                               |
| Autonomous regression (CI/CD)                                  | `.github/workflows/{ci,nightly,post-deploy}.yml`; `/regression` skill                                        |
| Routes / driver runs / POD                                     | api `src/routes/` → web `routes/`+`deliveries/` → mobile `(driver)/route/`                                   |
| Ad-hoc order trips / Deliveries                                | [`api`](api/feature-modules-3.md) → `src/trips/` → web `deliveries/` → mobile `(operator)/trips/`            |
| Returns / RMA (incl. Returns Inside Order Creation)            | STANDARD flow: [`api`](api/feature-modules-3.md) `returns/`. INLINE (PR-1a+): [`api`](api/returns-inline.md) |
| Developer mode (in-dev surfaces only)                          | [`web`](web.md)/[`mobile`](mobile.md) → `useDeveloperMode()`; addon-only since 2026-08-28                    |
| Recurring routes / order delivery split (2026-08-25)           | `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` — [`api`](api/feature-modules-3.md)                          |
| Shared DTOs / enums                                            | [`packages`](packages.md) → `packages/types/index.ts`                                                        |
| Shared UI components / tokens                                  | [`packages`](packages.md) → `packages/ui/src/{web,mobile}/`                                                  |
| Security headers / CSP                                         | [`web`](web.md) → `next.config.mjs`                                                                          |
| File uploads & signed URLs                                     | [`api`](api.md) → `src/uploads/`                                                                             |
| Realtime (Socket.io)                                           | api `src/gateways/` → web `lib/socket.ts` → mobile `hooks/useSocket.ts`                                      |
| Deploy / Dockerfile / health                                   | per-app `Dockerfile` + `railway.toml`; `debug-deploy` skill                                                  |
| Product capability model (problem → P0/P1/P2)                  | [`docs/product/`](../../docs/product/README.md) — 15 domains                                                 |
| Marketing docs (product doc, strategy, content pack)           | [`docs/marketing/`](../../docs/marketing/README.md)                                                          |

- **Verification layers:** 4 — `npm run verify` (types+lint+test) → `post-deploy-check`
  (read-only authenticated probe) → `feature-smoke` (write-path, approved test tenant only) →
  Playwright e2e. `npm run regression` chains 1→2→3. Detail: `docs/testing/verification-matrix.md`.

## Areas

- [`api`](api.md) — NestJS API: 30+ tenant-scoped feature modules, the multi-file Prisma schema
  folder (`apps/api/prisma/schema/*.prisma` — 7 domain files, 125 models; split + guarded by
  `scripts/split-prisma-schema.mjs`), auth, finance. Split 2026-09-13 into `api/*.md` parts —
  this file is now a table of contents; see `api.md`'s own module-index table.
- [`web`](web.md) — Next.js dashboard (operator), platform-admin panel, buyer portal, marketing.
  Split 2026-09-13 into `web/*.md` parts — see `web.md`'s module-index table.
- [`mobile`](mobile.md) — Expo multi-role app: `(auth)`, `(customer)`, `(driver)`, `(operator)`,
  `(tenant)`. Split 2026-09-13 into `mobile/*.md` parts — see `mobile.md`'s module-index table.
- [`packages`](packages.md) — shared `types`, `ui`, and build/config presets. Under the 100,000
  byte area cap — kept as a single file.

## How to navigate

1. Read this INDEX. Pick the area(s) the task touches from the table above.
2. Open that `<area>.md` — now a short table of contents — and pick the ONE part row your
   task needs (e.g. `api/feature-modules-3.md`, not all of `api/*.md`).
3. Open only that part file. Expand outward only where an entry's cross-refs say a change
   ripples.
4. After editing, update the touched entries in the part file (not here, unless the pointer
   itself changed) and bump `_meta.json`.
