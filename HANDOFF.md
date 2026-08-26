# HANDOFF — current state & what to pick up next

**Written:** 2026-08-26 (early AM — the 2026-08-25 queue SHIPPED in one window) · **Visibility:**
private (verified by read-back) · **CI:** GitHub Actions billing is STILL broken account-wide;
today's window used the free-public-minutes flow (flip public → rerun/trigger → merge → private).
Master's final run: Test/TypeCheck/Lint/Security ALL GREEN — the E2E (Playwright) job fails in
global-setup seed and has NEVER been green recently (nightlies red since ≥2026-08-22, pre-existing
infra — task chip filed). The pre-push hook's full `npm run verify` remains the authoritative gate.

## ✅ SHIPPED + LIVE 2026-08-26 window — NINE PRs merged, migration 20260905 applied, all deploys SUCCESS

Sequence executed: validated 12.15MB backup (126==126 CREATE TABLE) → migration
`20260905000000_customer_deposit_default` applied via prod-migrate.mjs → public window →
CI green per branch → serial rebase→hook-verify→merge pipeline → deploys SUCCESS → private
(read-back confirmed) → `post-deploy-check` GREEN → `feature-smoke` GREEN (write paths) →
demo reseed complete (59 orders / 51 invoices / 8 runs).

| PR   | What                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #438 | iOS invoice (PDF) share — lost-transient-activation retap recovery                                                                                                                                                                                                                                                        |
| #439 | Same for the CSV share path (retargeted to master BEFORE base delete — doctrine held)                                                                                                                                                                                                                                     |
| #440 | Idle super-admin cross-client 401 redirect hijack fixed; kills the /auth/refresh storms                                                                                                                                                                                                                                   |
| #441 | Purchase-orders list DTO coercion (`take:"20"` 500)                                                                                                                                                                                                                                                                       |
| #432 | repair-escaped-entities buyerAccount scoping via customerLinks + errorReason()                                                                                                                                                                                                                                            |
| #445 | **Buyer-connect auth hardening (HIGH)** — Google-merge squat hijack neutralized pre-link; email-change token/session revoke; roster-oracle redaction + request throttle; F3 audit script (owner runs read-only)                                                                                                           |
| #446 | **Tenant-scope findUnique sweep** — 79 sites / 23 files to findFirst; cross-tenant existence-oracle + data-echo closed; RULE recorded in the code map                                                                                                                                                                     |
| #442 | Customer-feedback batch phases 1+2 — address CRUD, agent quick-create, deposit defaults (migration `20260905`), due chips, qty-zeroing MONEY fix + zero-qty invariant, order-discount carried onto generated invoices, DELIVERED reopen + one-step-back demotions, delete-any behind the money gate, `deliveredOn` picker |
| #443 | `recurring_routes` / `order_delivery` split into independent addons; deploys dark                                                                                                                                                                                                                                         |
| #447 | demo-seed: clean route-stop rebuild on customer-map drift (found live during the reseed)                                                                                                                                                                                                                                  |

**Recovered from dead sessions before the window** (committed, rebased, hook-verified, then
merged above): the two uncommitted security batches (#445 — 24 files, #446 — 51 files) and
#442's fully-implemented phase 2 (21 files) — nothing from the interrupted sessions was lost.
Three cross-branch regressions the rebases introduced were caught by the hook gate and fixed
with specs (fulfillPath default-chain mocks, resolveDefaultTerms/deposit mocks, the
deleteOrder↔cancelImpact finder split).

## ✅ SHIPPED 2026-08-26 — #449 client-release-blockers (RESCOPED; CI green; deploy watched)

Plan `.claude/pipeline/plans/2026-08-25-client-release-blockers.md` rescoped: WP2/WP3
(customer address edit) SUPERSEDED — #442 phase 1's Addresses-tab CRUD already fixed that
defect. Built + merged as **#449**: **WP1** — order edits SETTLE stock (`settleStockForEdit`:
union deltas, product-row + Order-row `FOR UPDATE`, in-tx held snapshot, **delivered-clamp** —
negative deltas credit only the undelivered portion, so cancelling a delivered line no longer
inflates inventory; at-door approvals now settle too; specs a–j + at-door case, 253/253) and
**WP4-reduced** — EditTerms terms→dueDate linkage from the ISSUE date (the "Net 60 shows
Net 30" complaint) + `calendarDaysUntil` for the two remaining LOCAL-time badge sites
(`renderStatus`); helpers extracted to `web/lib/invoice-terms.ts`. Pipeline: Fable plan →
2 Sonnet implementers → Opus review (caught the delivered-clamp + stale-snapshot races) →
Opus fixer → hook verify + CI green → merged. **The bb-distro NO_GO verdict's three blockers
are now all closed** (terms↔date by #449, address edit by #442, stock settle by #449; the
badge −1-day survivor also by #449).

Same-day parallel session (from this session's task chip): E2E suite resurrection — all 5
red specs root-caused (4 REAL web bugs incl. a router.replace swallowing row clicks on all
13 list pages), PR #448 open — see memory `project_e2e_suite_resurrection_2026-08-26`.

## 🔴 OWNER ACTIONS (nothing else unblocks these)

1. **Fix GitHub billing** (Settings → Billing & plans) — Actions still refuses jobs outside
   free public windows; nightly regression red since 2026-08-22.
2. **Enable `driver_payments` for affa** (Admin → Tenants → affa → Addons) — until flipped,
   affa drivers 403 on at-door collection ($0/on-account unaffected).
3. After #443: assign `recurring_routes` / `order_delivery` per tenant as sold.
4. Run the #445 F3 audit read-only:
   `railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs`.
5. Google-key hygiene: restrict the new key to Geocoding + Places; delete stray project
   routeflow-489906.
6. E2E-on-master infra (task chip filed): the Playwright job's global-setup seed fails against
   the CI database; make the job meaningful again, then stop tolerating seed errors in
   `global.setup.ts`.

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
