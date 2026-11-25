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
- **Packages** — [`packages`](packages.md): `types`, `ui`, `scanning`, `config`, `eslint-config`,
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

| Need / symptom                                                 | Start at                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation engine                                        | [`api`](api.md) → `src/prisma/prisma.service.ts` `forTenant()`                                                       |
| Global guard wiring (Throttler/Tenant)                         | [`api`](api.md) → `src/app.module.ts`                                                                                |
| Startup, CORS, helmet, secrets                                 | [`api`](api.md) → `src/main.ts` `assertSecrets()`                                                                    |
| Env config & secret derivation                                 | [`api`](api.md) → `src/config/configuration.ts`                                                                      |
| Auth (server)                                                  | [`api`](api.md) → `src/auth/`                                                                                        |
| Auth (web client, tokens, tenant cookie)                       | [`web`](web.md) → `lib/api-client.ts`, `lib/auth.ts`, `lib/tenant-cookie.ts`                                         |
| Auth (mobile, SecureStore)                                     | [`mobile`](mobile.md) → `lib/api-client.ts`, `lib/auth.ts`                                                           |
| A domain end-to-end (e.g. invoices)                            | api `src/invoices/` → web `app/(dashboard)/invoices/` → mobile `lib/api/invoices.ts`                                 |
| Money / line totals (round, boxed)                             | [`packages`](packages.md) → `pricing` (`computeLineSubtotal`/`normalizeBoxesPieces`/`roundMoney`)                    |
| Invoice↔Order sync (both directions)                           | api `invoices.service.ts` `reconcileOrderDraftInvoice` (fwd) + `recomputeOrderFromInvoices` (back)                   |
| Delivered/billable basis for coverage (evidence, not status)    | `api/catchup-2026-09-21-src.md#invoices` — `invoices/delivered-basis-by-line.ts`                                     |
| MSRP / suggested retail on invoices                            | in-flight branch, NOT on master — see `api/where-to-find.md`                                                         |
| Duplicate purchase-invoice detection                           | [`api`](api/feature-modules-6.md) → `import/duplicate-match.service.ts`                                              |
| Supplier-statement reconciliation (AI)                         | [`api`](api/feature-modules-5.md) → `src/supplier-statements/`                                                       |
| Backdating an order (business date)                            | api `orders.service.ts` `parseOrderDate` (staff-only)                                                                |
| Sales agents & commissions (flag-gated)                        | [`api`](api/feature-modules-6.md) → `src/sales-agents/` (dark until `SALES_AGENTS` addon)                            |
| Lite invite-only plan / newly-enforced plan flags (2026-09-15) | [`api`](api/lite-plan.md) — cross-cutting, split out of `feature-modules-4.md`'s cap                                 |
| "When did the money land" on a payment                         | api `InvoicePayment.settledAt` vs `paidAt`; `bookkeeping.service.ts` `settledDateFilter`                             |
| Mobile scan-to-order (split view)                              | mobile `ScanOrderSheet.tsx` + `ScanTray.tsx` + `lib/scan-tray.ts`                                                    |
| Smoke / pre-push verify                                        | `npm run verify`/`smoke`/`post-deploy-check`; `smoke-check` skill                                                    |
| Root tooling, campaign infra, bug registry, Plane harness      | [`api`](api/root-tooling-campaign-infrastructure.md)                                                                 |
| Production data-integrity forensics                            | [`api`](api/root-tooling-campaign-infrastructure.md) → `data-integrity-report.mjs` + `repair-integrity.mjs`          |
| Test-tenant policy guard (allowlist)                           | `scripts/lib/test-tenants.cjs` `assertTestTenant`; policy in CLAUDE.md                                               |
| E2E Playwright                                                 | `apps/web/e2e/` — 6 spec files; `06-critical-paths.spec.ts` = money-math guard                                       |
| Autonomous regression (CI/CD)                                  | `.github/workflows/{ci,nightly,post-deploy}.yml`; `/regression` skill                                                |
| Routes / driver runs / POD                                     | api `src/routes/` → web `routes/`+`deliveries/` → mobile `(driver)/route/`                                           |
| Ad-hoc order trips / Deliveries                                | [`api`](api/feature-modules-3/trips.md) → `src/trips/` → web `deliveries/` → mobile `(operator)/trips/`              |
| Returns / RMA (incl. Returns Inside Order Creation)            | STANDARD flow: [`api`](api/feature-modules-3/returns.md) `returns/`. INLINE (PR-1a+): [`api`](api/returns-inline.md) |
| Developer mode (in-dev surfaces only)                          | [`web`](web.md)/[`mobile`](mobile.md) → `useDeveloperMode()`; addon-only since 2026-08-28                            |
| Recurring routes / order delivery split (2026-08-25)           | `RECURRING_ROUTES_ADDON`/`ORDER_DELIVERY_ADDON` — [`api`](api/feature-modules-3/routes.md)                           |
| Shared DTOs / enums                                            | [`packages`](packages.md) → `packages/types/index.ts`                                                                |
| Shared UI components / tokens                                  | [`packages`](packages.md) → `packages/ui/src/{web,mobile}/`                                                          |
| Security headers / CSP                                         | [`web`](web.md) → `next.config.mjs`                                                                                  |
| File uploads & signed URLs                                     | [`api`](api.md) → `src/uploads/`                                                                                     |
| Realtime (Socket.io)                                           | api `src/gateways/` → web `lib/socket.ts` → mobile `hooks/useSocket.ts`                                              |
| Inventory cost recompute / averageCost drift (B562)            | [`api`](api/feature-modules-4/inventory.md) → `replayProduct` gap detection; recompute UI hidden (#931)              |
| Deploy / Dockerfile / health                                   | per-app `Dockerfile` + `railway.toml`; `debug-deploy` skill                                                          |
| Product capability model (problem → P0/P1/P2)                  | [`docs/product/`](../../docs/product/README.md) — 15 domains                                                         |
| Marketing docs (product doc, strategy, content pack)           | [`docs/marketing/`](../../docs/marketing/README.md)                                                                  |
| Wholesaler onboarding (demo → live, 8 gated stages)            | [`docs/runbooks/wholesaler-onboarding.md`](../../docs/runbooks/wholesaler-onboarding.md)                             |
| Selling restrictions (Lane R), units_v1 order lines | [`api`](api/catchup-2026-09-21-src.md) → `selling-restrictions/`, `orders/unit-line-build.ts` → web `settings/restrictions/` |
| Product labels/categories, credit-limit guard | [`api`](api/catchup-2026-09-21-src.md) → `product-labels/`, `orders/credit-limit-guard.ts` |
| Tenant config snapshots (restore on re-upgrade) | [`api`](api/catchup-2026-09-21-src.md) → `billing/tenant-config-snapshot*.ts` → web admin `ConfigSnapshotsTab` |
| Scanning engine (shared), verify-turbo, release-health | [`packages`](packages.md) → `scanning`; [`api`](api/catchup-2026-09-21-scripts-schema.md) → `scripts/` |
| Marketing site print/motion, pin ledger, spec 85 | [`web`](web/landing-2026-11-13-bk-fixes.md) → `public/site/js/{home-up,site}.js`, `e2e/85-site-proof-pages.spec.ts` |
| Staff menu, active entry, g shortcuts | [`web`](web/landing-2026-11-21-w38.md) → `app/(dashboard)/_components/nav-index.ts`, `lib/nav-shortcuts.ts` |
| Invoice layout switches, open balance block | [`api`](api/landing-2026-11-21-w38.md) → `invoices/invoice-layout.ts`, `customers/invoice-account-balance.ts` |
| Sent-invoice edit confirm (ackSentRevert) | [`api`](api/landing-2026-11-21-w38.md) → `invoices/order-edit-revert-set.ts`, `orders/orders.service.ts` |
| Import skips a gated column | [`api`](api/landing-2026-11-21-w38.md) → `import/import-gated-columns.ts` |
| One writer for the Driver row | [`api`](api/landing-2026-11-21-w38.md) → `drivers/drivers.service.ts` `ensureDriverRow` |
| Email delivery route, ref token, bounce tables | [`api`](api/landing-2026-11-21-w38.md) → `email/email-delivery.service.ts`, `email/bounces/` |
| Purchase orders: create, receive, edit, close | [`api`](api/codemap-refresh-2026-11-22.md#purchase-orders-inventory) → `inventory/inventory.service.ts` `receivePurchaseOrder` |
| Vendor bills: create, receive, void, payments, PO gate | [`api`](api/codemap-refresh-2026-11-22.md#vendor-bills) → `vendor-bills/vendor-bills.service.ts`, `po-bill-match.ts` |
| Counter sale, park, void, pickup, day close | [`api`](api/codemap-refresh-2026-11-22.md#counter-sale-pickup) → `orders/counter-sale/counter-sale.service.ts` `ring`; web `CounterSaleScreen.tsx` |
| Order drafts: autosave, local mirror, resume | [`api`](api/codemap-refresh-2026-11-22.md#order-drafts) → `drafts/drafts.service.ts`; web `lib/order-draft/engine.ts` |
| Payment receipts: idempotency key, ref dedupe, edit | [`api`](api/codemap-refresh-2026-11-22.md#payment-receipts) → `invoices/payment-idempotency.ts`, `payment-ref-dedupe.ts` |
| Billing catch-up: claim, plan, checkout | [`api`](api/codemap-refresh-2026-11-22.md#billing-catchup) → `billing/catchup-claim.ts`, `catchup-plan.ts`, `catchup-checkout.service.ts` |
| PO bill line judged in its own unit (check X) | [`api`](api/landing-2026-11-23-w39.md) → `vendor-bills/po-bill-match.ts` |
| Bill-line unit and identity (lot, split child) | [`api`](api/landing-2026-11-23-w39.md) → `vendor-bills/bill-line-identity.ts`, `bill-item-data.ts` |
| Per-tenant sidebar layout (pinned) | [`api`](api/landing-2026-11-23-w39.md) → `system-config/nav-layout-settings.ts` |
| Buyer portal spend (invoices less credit notes) | [`api`](api/landing-2026-11-23-w39.md) → `buyer/buyer-spend.ts` |
| Product display name (Family - Variant) | [`api`](api/landing-2026-11-23-w39.md) → `packages/types/api/product-name.ts` |
| Inventory dialog panel (scroll, keep Save in view) | [`web`](web/landing-2026-11-23-w39.md) → `inventory/_components/modal-panel.ts` |
| Heavy-slot priority, max-cpu file; campaign-check timeout | [`api`](api/landing-2026-11-23-w39.md) → `scripts/lib/heavy-slot.mjs`, `campaign-force-run.cjs` |
| Receipt group (what one payment covered, read-only) | [`api`](api/landing-2026-11-23-w40.md) → `invoices/payment-receipt-group.ts` |
| Returned items and one word for credit (counter) | [`api`](api/landing-2026-11-23-w40.md) → `orders/counter-sale/counter-return-read.ts`, `common/credit-words.ts` |
| Generated-dirs list for cross-workspace scans | [`api`](api/landing-2026-11-23-w40.md) → `scripts/lib/generated-dirs.cjs` |
| Create PO scan bar | [`web`](web/landing-2026-11-23-w40.md) → `inventory/_components/PurchaseOrderScanBar.tsx` |
| Sidebar order and hidden (F-2) | [`web`](web/landing-2026-11-23-w40.md) → `_components/nav-layout.ts` |
| PO lot lines in whole packs (create, edit, receive) | [`api`](api/landing-2026-11-23-w41.md) → `vendor-bills/bill-line-identity.ts` |
| Available credit, one helper for every statement surface | [`api`](api/landing-2026-11-23-w41.md) → `customers/available-credit.ts` |
| Buyer statement credit total and list | [`api`](api/landing-2026-11-23-w41.md) → `buyer/buyer-statement-view.ts` |
| Counter tender intent and on-account button | [`web`](web/landing-2026-11-23-w41.md) → `lib/counter-part-pay.ts` |
| Buyer portal credit tile | [`web`](web/landing-2026-11-23-w41.md) → `app/buyer/portal/[seller]/finances/page.tsx` |
| Payments list one row per check (receipt tag) | [`api`](api/landing-2026-11-23-w42.md) → `invoices/payment-receipt-group.ts` |
| Receipt screen, View receipt link and toast | [`web`](web/landing-2026-11-23-w42.md) → `app/(dashboard)/finance/payments/[id]/page.tsx` |
| Buyer invoice account rows, one renderer | [`web`](web/landing-2026-11-23-w42.md) → `components/InvoiceAccountRows.tsx` |
| Buyer payment status word | [`web`](web/landing-2026-11-23-w42.md) → `lib/check-badge.ts` |
| Ops board comments and rf inbox | [`api`](api/landing-2026-11-23-w42.md) → `tools/ops-monitor/lib/inbox.mjs` |
| Group receipt card (receipt fields vs this payment) | [`web`](web/landing-2026-11-24-w43.md) → `app/(dashboard)/finance/payments/[id]/page.tsx` |
| Buyer portal home landing (0 orders to Invoices) | [`web`](web/landing-2026-11-24-w43.md) → `app/buyer/portal/[seller]/page.tsx` |
| PO create retry, edit line product lock | [`web`](web/landing-2026-11-24-w43.md) → `inventory/_components/PurchaseOrderLinesTable.tsx` |
| Alias pack memory and void date columns (schema only) | [`api`](api/landing-2026-11-24-w43.md) → `prisma/schema/catalog.prisma`, `finance.prisma` |
| Local mail TLS pair, fleet CLI | [`api`](api/landing-2026-11-24-w43.md) → `scripts/lib/mailpit-tls.mjs`, `scripts/fleet.mjs` |
| Pre-push verify fail-fast (RF_VERIFY_FAIL_FAST) | [`api`](api/landing-2026-11-24-w44.md) → `scripts/lib/verify-fail-fast.mjs` |
| Edited test assertions flagger | [`api`](api/landing-2026-11-24-w44.md) → `scripts/review-test-edits.mjs` |
| Dashboard overdue days, new-sale quantity | [`web`](web/landing-2026-11-24-w44.md) → `app/(dashboard)/dashboard/page.tsx` |
| Supplier bill from a purchase order (prefill, by-hand lines) | [`web`](web/landing-2026-11-24-w45.md) → `lib/po-prefill.ts` |
| PO bill plan, one line one unit | [`packages`](packages/landing-2026-11-24-w45.md) → `pricing/src/po-bill-lines.ts` |
| Document number year (tenant calendar year) | [`api`](api/landing-2026-11-24-w46.md) → `src/common/number-year.ts` |
| Return credit last-paid cap | [`api`](api/landing-2026-11-24-w46.md) → `src/returns/inline-returns-pricing.ts` |
| Counter quantity box hold (Enter, Tab, blur) | [`web`](web/landing-2026-11-24-w46.md) → `components/use-held-qty.ts` |
| Invoices Follow up view, due-soon filter | [`web`](web/landing-2026-11-24-w46.md) → `app/(dashboard)/invoices/follow-up-view.tsx` |
| Plan key ladder (CORE, ALL_IN) | [`api`](api/landing-2026-11-24-w46.md) → `src/billing/plan-catalog.constants.ts` |
| Heavy-slot max-mem file, prod-migrate-resolve | [`api`](api/landing-2026-11-24-w46.md) → `scripts/lib/heavy-slot.mjs` |

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
