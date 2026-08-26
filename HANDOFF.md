# HANDOFF — current state & what to pick up next

**Written:** 2026-08-25 (late evening; two ship windows done, five PRs queued, one pipeline in
flight) · **Visibility:** private · **CI:** GitHub Actions billing is BROKEN account-wide
("recent account payments have failed") — jobs refuse to start even in public windows until the
owner fixes GitHub **Settings → Billing** — BUT free public-window minutes still work, which is
how today's merges got green CI (flip public → `gh run rerun` the billing-refused run → green →
merge → wait `BUILDING` → private). Same-day discovery: **Google Cloud billing is ALSO dead**
(same payment method?) — see Owner Actions. The pre-push hook's full `npm run verify` remains
the authoritative local gate.

## ✅ SHIPPED + LIVE 2026-08-25 — #435 ad-hoc trips + fulfillment + driver payments · #437 follow-ups

Two windows, both: CI green → squash-merge → `BUILDING` → private verified → deploys SUCCESS →
post-deploy green.

- **#435**: ad-hoc order trips (multi-select orders → trip builder → optimize → dispatch;
  `Route.kind ADHOC`, driver run flow inherited untouched) + `Order.fulfillPath ROUTE|SHIP`
  (reuses the dormant enum; `Customer.fulfillPath` live as the new-order default; SHIP excluded
  from dispatch with visible reasons; invoicing parity spec-pinned) + **driver_payments opt-in**
  (body-aware `DriverPaymentsGuard` on complete-with-payment: only `payment.amount > 0` needs
  the addon; $0/on-account closes work for every tenant). Migration `20260904` applied
  (validated 11.9MB backup first; SHIP-customer audit CLEAN — only the demo seed).
  Sweep hardening (`fulfillPath: ROUTE` in the dispatch sweep) shipped with a clean audit —
  no live tenant affected.
- **#437**: demo-seed commission-chain teardown fix + trip-demo readiness (synthetic coords —
  optimize works keylessly via the local fallback) + platform-admin **Driver payments toggle**
  (consequence-stating copy) + addon-toggle failures now surface (was a silent `catch {}`).
- Live feature probe green: `/trips/eligibility` serving, `fulfillPath` on payloads,
  `driver_payments`+`developer_mode` active on `routeflow-demo`.

## 🟡 OPEN PRs — all verify-green, queued for the next windows (merge order matters)

| PR   | Branch                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                            |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #438 | fix/ios-share-activation     | iOS invoice sharing: `NotAllowedError` (transient activation lost during PDF fetch) now routes to the tap-again recovery instead of a dead toast                                                                                                                                                                                                                                                                                                                                                                                                                         | Land FIRST                                                                                                                                                                                                                                       |
| #439 | (stacked on #438)            | Same fix for the CSV share path (parallel session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **RETARGET to master after #438 merges, before deleting the base branch**                                                                                                                                                                        |
| #440 | fix/admin-session-hijack     | Idle super-admin page bounced to buyer/login pages: operator+buyer clients redirected on 401s from surfaces they don't own; both now redirect only on their own surfaces                                                                                                                                                                                                                                                                                                                                                                                                 | Also kills the `/auth/refresh` rate-limit storms in prod logs                                                                                                                                                                                    |
| #443 | feat/order-delivery-split    | Recurring routes vs Order delivery = two independent addons (`recurring_routes`, `order_delivery`); web `/deliveries` (Plan delivery + history); `/routes` un-mixed; mobile mirrored; `developer_mode` stays master switch                                                                                                                                                                                                                                                                                                                                               | No migration; deploys dark                                                                                                                                                                                                                       |
| #442 | feat/customer-feedback-batch | Phase 1 committed: address CRUD+primary (+ new DELETE endpoint w/ route-stop 409), agent quick-create, per-customer deposit defaults, Due today/tomorrow/7d chips, shipment-panel gating. **Phase 2 pipeline IN FLIGHT** (wf_9e0b7132): boxes:0/pieces:0 **qty-zeroing money bug** + zero-qty invariant, order-discount carried onto generated invoices (was DROPPED — over-billing), reopen DELIVERED + one-step-back demotions from any state, delete-any-order behind warning (payments-attached invoices still block), New-sale delivery-date picker (`deliveredOn`) | ⚠️ **Migration `20260905000000_customer_deposit_default` must be applied BEFORE this deploy** (one nullable column, additive). Phase 3 queued: tenant setting to show tier prices plainly on invoices (no strikethrough) — recon done, plan next |

## 🔴 Root-caused live bugs covered by the queue (evidence in the PR bodies)

1. **"Order created but invoice could not be generated" / "$0 orders"** = the New-sale screen
   sends `boxes:0, pieces:0` and the server let that overwrite qty with 0 (verified on a live
   order: lines `qty 0.000` at full unitPrice). Phase-2 fix + invariant. The damaged live order
   becomes self-repairable after deploy: Reopen → Edit Items → invoice re-syncs.
2. **Order-level discount silently dropped** on invoice generation (demo-proven $20/$20 → $20
   invoice). Phase-2 proration fix.
3. **Idle admin page hijack** (#440) — cross-client 401 redirect bleed, not session expiry.
4. **Phone invoice sharing** (#438/#439) — iOS transient-activation, spec-confirmed.
5. Purchase-orders list crash (`take: "20"` string) — spawned as its own task/PR by the owner.

## 🔴 OWNER ACTIONS (nothing else unblocks these)

1. **Fix GitHub billing** (Settings → Billing & plans) — Actions refuses jobs account-wide.
2. **Fix Google Cloud billing** on the maps project — `GOOGLE_MAPS_API_KEY` IS set and served
   to the web app; Geocoding/Places return `REQUEST_DENIED: enable Billing`. Until then:
   geocoding + address autocomplete are dead on prod; optimizer falls back to stored coords.
3. **Enable `driver_payments` for affa** (Admin → Tenants → affa → Addons) — until flipped,
   affa drivers get a clear 403 on at-door collection ($0/on-account completions unaffected).
4. After #443 deploys: assign `recurring_routes` / `order_delivery` per tenant as sold.
5. Merge windows for the five queued PRs (assistant can run them on request — order per table).

## Deploy runbook for the queued batch

1. Backup → `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`
   (applies `20260905`; `20260904` is already live). ⚠️ bare `railway run pg_dump` writes a
   0-byte dump — use the postgres-service proxy vars (see memory / #435 runbook).
2. Public window: rerun CI per PR → merge in table order (#438 → retarget #439 → #440 → #443 →
   #442) → wait `BUILDING` → private (verify read-back) → deploys SUCCESS → post-deploy-check.
3. Demo refresh (`demo-seed.js --live`) after #442 to exercise deposit defaults + due chips.

## ✅ SHIPPED + LIVE 2026-08-24 (evening) — #433 addon hygiene · #434 tobacco consolidation

Both merged, deployed (api/web/mobile SUCCESS), post-deploy green.

- **#433**: addon enable validates against the published catalog (400 + remedy); every toggle
  invalidates the entitlements cache; self-service allowlist (MSRP/SALES_AGENTS admin-only);
  6 vaporware admin toggles deleted; catalog **v11 published** (BUYER_PORTAL/SEAT_EXTRA/
  OCR_PACK_250/ROUTE_EXTRA/MSG_BUNDLE_500 retired); 7 inert TenantAddon rows deactivated;
  consistency probe: ZERO orphaned grants. Full evaluation: the Addon Truth Matrix artifact.
- **#434**: ONE regulated surface — /tobacco retired into the Regulated Items hub as the
  addon-gated 'Regulated compliance pack' (same tobacco_dealer key). Product.isTobacco is a
  write-synced mirror of Tobacco-type membership (un-flag PRESERVES the reg reporting trio).
  NO migration. **Byte-equivalence PROVEN**: demo July report identical pre/post-deploy.
  Backfill executed: routeflow-demo 16 + affa 66 mirrors healed, 0 conflicts, re-run clean —
  those 66 affa tobacco products were MISSING from compliance reports until now; regenerating
  any PAST affa period will now include them (owner decision before restating filed periods).
  Fresh validated backup: production_20260824_pre-tobacco-consolidation.sql (126==126).

Also 2026-08-24: sales-agents outage root-caused (catalog v10 was never published — published
same day) and demo fully seeded (2 agents, backdated rates, CST-2026-0001 approved + $700
partial payout). In-flight elsewhere: the ad-hoc order trips session (feat/adhoc-order-trips,
migration slot 20260904 claimed) — its runbook: prod migration BEFORE deploy; check
GOOGLE_MAPS_API_KEY exists on the prod API service.

## ✅ SHIPPED + LIVE 2026-08-24 (morning window) — #427 / #428 / #429 / #430

All four merged in ONE public window (public → squash-merge x4 → all three services BUILDING →
private confirmed → deploys SUCCESS → post-deploy-check GREEN). What landed:

| PR   | What                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #427 | Repair scripts: receiving-units (HIGH-signature + printed recompute-costs follow-up), escaped-entities, drift scan covers TRIAL                                                        |
| #428 | NSF bounce fees excluded from the commission base (shared NSF_FEE_DESCRIPTION_PREFIX; ratio deliberately conservative). Pipeline clean + Fable money-pass PASS                         |
| #429 | PR-D — full sales-agents & commissions UI (agent box, statements w/ stale-409 regenerate, order override, mobile row, e2e 18). Dark until the sales_agents addon is enabled per tenant |
| #430 | This handoff refresh                                                                                                                                                                   |

## 🔵 Enforcement is LIVE (2026-08-23)

`PLAN_FLAG_ENFORCEMENT=on` set on the API service by the owner, deploy `9090d918` SUCCESS,
`post-deploy-check` green. The audit script showed ZERO tenants lose anything. Kill switch
removal date stands: 2026-10-01.

## 🔵 Client-data repairs — exact sequence for the owner (#427 is merged; `git pull` first)

All from `C:/ClaudeCode/routeflow` (main checkout). Backups first where marked.

1. **bb-distro drift report** (works even BEFORE #427 via explicit slug):

   ```bash
   set REPORT_TENANT_SLUG=bb-distro&& railway run --service postgres node apps/api/scripts/report-receiving-unit-drift.mjs
   ```

2. **affa receiving repair** (client has reported the symptom; still take a fresh validated
   backup first): dry-run → review the printed plan → execute → run the printed
   `POST /inventory/recompute-costs` body as an operator.

   ```bash
   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs --tenant=affa
   ```

   ```bash
   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs --tenant=affa --execute --confirm-tenant=affa --live-tenant-override
   ```

3. **bb-distro escaped-entities repair** (3 rows in the census; needs the client's explicit
   request + fresh backup): dry-run → execute, same flag pattern with `--tenant=bb-distro`
   via `apps/api/scripts/repair-escaped-entities.mjs`.

4. **PR-D rollout**: enable the `sales_agents` addon on `routeflow-demo` from platform-admin,
   exercise the agent box + a statement cycle there, then enable for the requesting client.

## ✅ SHIPPED + LIVE 2026-08-23 — the client-2 feedback batch (12 PRs, 3 prod migrations)

All merged, deployed, `post-deploy-check` green after every wave. Memory
`project_client2_feedback_batch_2026-08-22` holds the full per-PR detail.

| PR          | What                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #416 + #424 | Sale flow honours chosen terms/due-date; −1-day calendar rendering fixed everywhere (UTC-safe `fmtCalendarDate` web + mobile `lib/format-date.ts`; timestamps stay local)                                                                                                                                                                                            |
| #417        | Inventory RECEIVING converts boxes→pieces (Quick Restock + PO receive); silent under-receive clamp → loud reject; on-hand renders `N pcs (X boxes + Y pcs)`; read-only `report-receiving-unit-drift.mjs` stages the client stock repair                                                                                                                              |
| #418        | Three tier-blind edit paths now honour `Customer.pricingTier` (server `updateOrderItems` operator branch → SPECIAL never MANUAL; web order-edit add-item; web invoice-edit page)                                                                                                                                                                                     |
| #419        | Tenant-configurable tier names (`pricing.tierLabels` SystemConfig; `tierLabel()` triple-mirrored; settings card)                                                                                                                                                                                                                                                     |
| #414        | `StripHtml` no longer stores `&amp;`; supplier create refreshes every list (cross-invalidated query keys). Stored-`&amp;` repair still pending (read-only census script exists)                                                                                                                                                                                      |
| #420        | Plan-flag enforcement wired, **INERT** — `PLAN_FLAG_ENFORCEMENT` defaults off; audit script `apps/api/scripts/audit-tenant-entitlements.mjs` written for the owner to run BEFORE ever switching on                                                                                                                                                                   |
| #421        | Sales agents & commissions ENGINE (PR-C), **ships dark** (`flag.sales_agents` granted by no plan). Migration `20260901` APPLIED. Post-pipeline Fable review caught a CRITICAL (approve() blind to clawbacks = commission on bad debt) — fixed pre-merge                                                                                                              |
| #422        | Payment terms model: `Invoice.paymentTermsLabel` (label/due-date can never disagree — the INVARIANT), `Customer.defaultPaymentTerms`, `Supplier.defaultTerms`, `VendorBill.termsLabel`, deposit v1 (`depositPercent`/`depositDueDate`, derived amount via `roundMoney`, status/AR-aging untouched), narrow `PATCH /invoices/:id/terms`. Migration `20260902` APPLIED |
| #423        | Geocode on customer CREATE; `Supplier.lat/lng` + autocomplete; mobile `AddressAutocompleteInput`; **bonus: repaired the pre-existing broken mobile New-customer flow**. Migration `20260903` APPLIED                                                                                                                                                                 |
| #425        | Test-only: un-fused the commission/entitlements mock providers (the 2026-08-23 incident — see below)                                                                                                                                                                                                                                                                 |

**Prod backups** (validated, in gitignored `backups/`): pre-`0901`, pre-`0902`, pre-`0903` dumps.

> ⚠️ **Incident record (2026-08-23), lessons binding:** (1) `npm run verify | tail && echo MARKER`
> eats npm's exit code — NEVER gate on a marker after a pipe; capture the exit directly.
> (2) Keep-both conflict unions must respect object-literal boundaries — two provider hunks fused
> into one object gave duplicate `provide:` keys and JS last-key-wins silently dropped a DI mock
> (207 test failures, prod unaffected, fixed as #425). (3) Prod smoke green ≠ suite green.
> (4) After merging a schema-bearing branch into a worktree: `npx prisma generate` or tsc lies.

## 🔴 Owner queue

1. ~~Flag enforcement switch-on~~ **DONE 2026-08-23** — see the Enforcement section above.
2. ~~NSF-fee commission question~~ **SHIPPED #428 (2026-08-24)**.
3. ~~PR-D — sales agents UI~~ **SHIPPED #429 (2026-08-24)** — enable the addon per tenant (demo first).
4. **Client-2 data repairs** — scripts built (#427); exact command sequence in the repairs
   section above. Client sign-off + fresh backup before any `--execute`.
5. **Standing pre-batch items**: 600 product images (client review gate), returns §2.1 decision,
   costing + pack-size prod repairs (reports await sign-off), `test-tenant` identity question,
   layout audit batches L2–L6 (findings doc is machine-local under `docs/audit/`).

## Repo & tooling state

- **Heavy-files policy (owner, 2026-08-23)**: no images/videos/office binaries in git — evicted
  `docs/RouteFlow-v1.0.0-Documentation.{docx,pdf}` + `docs/screenshots/` (7.1MB, 54 files) to the
  machine-local, gitignored `local-assets/` (copies preserved at
  `C:\ClaudeCode\routeflow\local-assets\docs\`). History still carries the blobs; a
  `git filter-repo` rewrite is a separate owner decision. Mobile app icons stay (build assets).
- **dev-pipeline skill** gained `workdir` (worktree isolation baked into every agent prompt),
  `packages[].dependsOn` (no more fake file-overlap ordering), tiered `verifyCommands`
  (`perRound`/`final`), per-package `model`, and prettier-on-touched-files. A **Fable adversarial
  pass on money-critical diffs is a standing close-out step** — it caught #421's CRITICAL after
  3 Opus lenses + refuters passed clean.
- **Migration slots used**: `0831` MSRP · `0901` agents · `0902` terms · `0903` geocode. Next free:
  `20260904000000_*`. One migration-bearing PR in prod-apply flight at a time; apply BEFORE merge.
- Worktrees/branches from the batch are pruned (or being pruned) — work in your OWN worktree off
  master, never `git add -A` in the shared checkout.

## Session mechanics (unchanged, still true)

Ship flow per CLAUDE.md (public window minimal, private flip is a `finally`, wait for `BUILDING`).
Local stack, prod DB access, e2e fixtures, RN-web driving, slow commits (240s), policy anchors:
see CLAUDE.md and the memory index — this file no longer duplicates them.
