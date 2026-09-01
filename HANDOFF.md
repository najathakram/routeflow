# HANDOFF — current state & what to pick up next

> # ▶️ CAMPAIGN RESUMED — F03 SHIPPED, F17 IN FLIGHT (2026-08-31/09-01)
>
> The pause below was lifted by the owner. Since it was written: **F03 SHIPPED** (#564, master
> `f1599490` — 8 of its 9 bugs `done`, B11 T2 `proven-pending-deploy`), **#565** landed the two
> native launch blockers (B203/B204), and **F17 is in flight as PR #566** (branch
> `fix/F17-import-robustness`, merge commit `56a965e0`).
>
> **F17 — import robustness (B98, B99 both Critical; B112; B08).** `parseFloat("1,234.56")` is
> `1`, so $1,234.56 imported as $1.00 across four importers; a payments re-upload had no dedupe
> at all despite a comment promising one, so every retry doubled recorded payments and flipped
> invoices to PAID; Excel's UTF-8 BOM blanked column one; the Migration Hub started jobs for
> connectors that only exist as a stub that throws. All four fixed, ledger flipped to
> `proven` / `proven-pending-deploy`, campaign-check green 4/4, full `npm run verify` green
> (3338/3338 api tests).
>
> ⚠️ **Two things F17 leaves for whoever picks up next.** (1) **B205 is a NEW register entry**,
> not a miss: the Migration Hub's own products-CSV path still carries B98's class. A fix was
> written in F17 and **deliberately reverted** after adversarial review — routing `pricePerUnit`
> through a lenient parser turned a present-but-unparseable price from a loud `products.create`
> throw into a **silent $0.00 commit**, and `parseFloat` leniency admitted `-$5`/`12abc`on a
path that calls`ProductsService.create()`in-process, so the DTO never runs. It needs its own
batch with an e2e (no web unit runner). (2) **B99's repair flight is owed post-deploy**:`scripts/repair-f17.mjs`, fresh backup first, dry run, apply only exact-signature duplicate
> pairs.
>
> **State — 24 of 193 terminal before F17; F17 adds 4 (3 immediately, B08 on deploy).**
> Complete: F00+F01 enablement, F02 (9), F04 (3), F30 (12), F03 (9).
>
> ## To resume, in this order
>
> 1. `git fetch origin master` — expect `4d57a4ca`. The last CODE commit is `d616a47d` (#556);
>    everything above it is docs-only (#557 pause banner, #558 code-map). If master carries code
>    commits newer than `d616a47d`, someone else moved it — reconcile before resuming.
> 2. **F03 first** (worktree `.claude/worktrees/rf-F03`, branch `fix/F03-payment-truth`,
>    2 commits ahead of master). Its pipeline stopped at the implement/review boundary with
>    REAL but WHOLLY UNVERIFIED output — no red gate, no jest run, no review lenses, no mutation
>    probe. Before anything else:
>    - **Drop `80b75ff9`** (`chore(format)`) — it is the pipeline's repo-wide prettier pass over
>      47 files F03 never touched, isolated on purpose so it can be reverted in one move.
>    - Resume the engine: `Workflow({scriptPath: "C:/Users/nakram/.claude/skills/dev-pipeline/pipeline.js", resumeFromRunId: "wf_7bd33cd7-ac3"})`.
>      Completed agents replay from cache; read `journal.jsonl` in the run's transcript dir first
>      rather than assuming what landed.
>    - Finish the two known loose ends: `scan-known-bugs.json` still needs the whole
>      `draft-payment-not-void` block deleted (only one site was pruned), and F03 owes a prod
>      **repair flight** (backup → `repair-f03.mjs` dry-run → apply → integrity re-check, board #516).
>    - ⚠️ Notable finding already banked in `d1269474`: the **F04 oracle-cap check confirmed the
>      server shared the mirrors' over-billing hole**; `buildInvoiceItemData` now caps
>      `billedThrough` at `basisQty`. That needs a REG-B50-tokened proof before it can be claimed.
> 3. Then the audited schedule: F06 → F07 → F11 → F22+F24 → F16 on track A; F05, F10, F09, F15,
>    F13, F14, F12, F17 (staged, artifacts committed), F19 → F20, F21 after F16, F25 → F26, F08,
>    Wave C, then F31.
>
> ## Owner-blocked (nothing I can do)
>
> - **Expo build** — F30's mobile scan fixes are merged but only reach devices via a build; the
>   server half is live and stricter, so old clients are safe meanwhile. Client retest after.
> - **GitHub Actions billing** for private minutes — until fixed, every CI green needs the public
>   window and the repo stays PUBLIC per the standing directive.
> - **Final flip to private** when the campaign closes.
> - **RLS arming** (D3) stays parked at `prisma/deferred-rls/`; 15 tables still hold NULL-tenant rows.
> - **Policy-layer proposal** (artifact `b3592216…`) — four asks still open.
>
> ## Verified-clean inventory at pause
>
> | Worktree                  | Branch                      | State                                                 |
> | ------------------------- | --------------------------- | ----------------------------------------------------- |
> | main                      | `master` @ `d616a47d`       | clean, green, deployed                                |
> | rf-F03                    | `fix/F03-payment-truth`     | MERGED (#564) — prunable                              |
> | rf-F30                    | `fix/F30-scan-loss`         | clean, MERGED (#555) — prunable                       |
> | rf-F04                    | `fix/F04-pricing-mirrors`   | clean, MERGED (#554) — prunable                       |
> | rf-F17                    | `fix/F17-import-robustness` | **IN FLIGHT — PR #566**, verify green, ledger flipped |
> | rf-F02b, campaign-kickoff | merged branches             | prunable                                              |
>
> Register artifact `310ae33a…` is CURRENT (198 findings, every shipped fix chipped). The
> user-guide artifact `cae40575…` is shared-not-owned — guide changes must be flagged to the owner.

**Written:** 2026-08-31 · **Visibility:** ⚠️ **PUBLIC by owner directive until the campaign completes** (do NOT flip private mid-campaign; the final flip is the owner's if the session dies) · **Campaign:** `F00+F01+F02(9)+F04(3) SHIPPED LIVE · F30 closing out (12 more: B190–B201 — scan-loss cluster, mobile+api one PR, migration 20260910 order_idempotency prod-applies BEFORE its merge) · 24/193 at F30's merge · F03/F17 staged next (F03 owes the oracle-cap check + deletes its scan-known-bugs block), then the audited two-track schedule (board artifact 9e97d8f6…)`. Owner delegations ACTIVE (.claude/campaign/DECISIONS.md D1–D6 + memory): Fable review replaces owner approval except system-harm/client-data risk; merge-as-ready any hour; repair-as-we-go per batch; repo stays public. ⚠️ Register debt SETTLED at F30 close-out (chips for F02/F04, new articles B189–B201, artifact republished) — keep it settled: every later batch updates the register in its own close-out.

> **W1 ✅ SHIPPED 2026-08-30:** F00 = PR #545 → master `7e5c2d98`; deploy-signal E2E **proven
> live** (run started 21s after deploy SUCCESS; echo event self-skipped without cancelling);
> post-deploy 9/9 + feature-smoke green; measured Verify = 5m11s/run. ⚠️ **Actions billing still
> refuses private minutes account-wide** (0-step failures) — every CI green still needs a public
> window until the owner fixes Settings → Billing. F01 adds migration slot
> `20260908000000_campaign_schema_foundation` (additive only, 12 columns + 2 enum values across
> 8 models — see `.claude/pipeline/2026-08-30-campaign-schema-foundation/`).

> **F30 ✅ CLOSING (this PR):** the owner-reported mobile scan-loss cluster, B190–B201 (12 bugs,
> 13/13 + 1325 mobile green, campaign-check 12/12). Mobile: 4-slot scan gate, pending buffer,
> resolve abort, archived outcome, boxed-qty fold, synchronous wedge clear, never-silent offline
> drain (hook-level wiring test kills the escaped `notifyFailed` mutant — proven red under the
> mutation), iOS toast host, per-cart-session Idempotency-Key. API: replay + content-409 +
> first-key-wins on POST /orders, all-or-nothing diff-add, explicit-only replaceAll,
> denomination-aware atomic merge (MANUAL-only price survival), buyer scan endpoint.
> **Migration `20260910000000_order_idempotency` (additive) prod-applies BEFORE the merge.**
> Residuals recorded in the fix card: `POST /orders/sell` has no idempotency (candidate future
> register entry); single-slot key carry on multi-loser merges (Low, by design). Client retest +
> an Expo release are owed to the owner — the mobile half only reaches devices via a build.

## 🟡 ACTIVE — bug-register burn-down campaign (W1: F00)

Full plan: `C:\Users\nakram\.claude\plans\read-the-bug-registry-scalable-gosling.md` (28 fix
batches F02–F29 + two enablement batches F00/F01, ~30 PRs across 8 merge windows W1–W8; all
Criticals close by end of W6). Register: `local-assets/docs/routeflow-bug-register.html`
(**188 entries, 180 open** — B188 added 2026-08-31, see below; artifact
`310ae33a-f47a-4d67-876d-4f3c880200a5` — the old `da34f8d6…` URL is DEAD, never publish to it);
user guide artifact `cae40575-f391-4db3-b0c4-d3da779fcfba` (shared-not-owned — sessions cannot
republish it; flag guide changes to the owner).

**State of the machinery (all of it ships in the F00 PR, branch `fix/F00-ci-campaign`):**

- **Ledger seeded and tracked** — `.claude/campaign/status/F##.jsonl`, one shard per batch
  F00–F29, 180 rows (id / batch / frozen tier / state / pr / proof / evidence / roundSha).
  **B126/B127 are `already-fixed`**: shipped pre-campaign via PR #506 (master `cc8c7d46`),
  deployed, post-deploy-check 9/9 — evidence names the two #506 specs. That is F02a done;
  F02b (B24, B96, B101, B130, B154, B188) is not started.
- **`scripts/campaign-check.mjs`** — the unfakeable gate; now **wired into `npm run verify`**
  (step 3, before turbo), so every PR and the pre-push hook reconcile ledger claims against
  jest/Playwright JSON run artifacts. Proven to fail on synthetic bad claims and to pass the
  real ledger. Run artifacts go to `.campaign/runs/` (gitignored).
- **Citations re-anchored** — audit + per-batch attention list in
  `.claude/campaign/citation-reanchor-log.md` (1,176 checked against `6c8f1401`, 13 corrected
  in the register, 47 multi-candidate flags for per-batch discovery). Read it before any
  batch's discovery phase.
- **28 F-cards** at `.claude/pipeline/fix-cards/F##-<slug>.md` — each dev-pipeline run's brief;
  never re-read the register in a batch.
- **Decisions of record** in `.claude/campaign/DECISIONS.md` — D1: no web unit runner, web-side
  logic stays tier T2 (proven post-deploy via the e2e run); D2: B126/B127 stay `already-fixed`.
- **Board driver is on master** — PR #507 landed `scripts/team/team.mjs`, the `team` skill and
  the three agent roles, so fresh worktrees off master have the board. Campaign epics/batch
  issues: seed via `team.mjs epic/task` if not yet present.
- **B188 (added 2026-08-31, capability-model follow-up):** `generateInvoicePdf`
  (`apps/api/src/bookkeeping/invoice.service.ts:37-91`) reads AND writes `transaction` on a bare
  unscoped Prisma client — the missed sibling of the F1-002 fix. Dormant (the "invoices" Bull
  queue has no producer); routed to F02b, tier T1, cited fresh on `77b88623`. Plan prose says
  "179" — the ledger, not the prose, is `campaign-check`'s source of truth.

**⚠️ F00's merge is also the LIVE TEST of the `deployment_status` E2E trigger** (`2073d6be` —
untestable on a branch: GitHub only runs the default branch's copy for that event). After F00's
first master deploy, an "E2E (Playwright)" run must appear within ~20 min, or apply the
two-line revert spelled out in ci.yml's `on:` block. Also record F00's measured billed minutes —
it is the CI diet's proof.

**Then:** F01 (consolidated additive migration, slot `20260908000000_*` — backup first,
`prod-migrate.mjs` BEFORE the merge, per CLAUDE_SESSION_PREAMBLE.md), then Wave A batch loop:
worktree off master → dev-pipeline from the F-card → `REG-B###` proofs → ledger flip in the PR
→ `npm run verify` → merge train → register/guide update in the main checkout → republish.

---

## Pre-campaign history below (2026-08-24 through 2026-08-26)

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
4. ✅ DONE 2026-08-26 via #450 (script connection fixed; first read-only run: 16 suspects,
   12 e2e fixtures, 1 reported). ~~Run the #445 F3 audit read-only:
   `railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs`.~~
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
  `20260908000000_*` (20260904/20260905/20260907 applied). One migration-bearing PR in
  prod-apply flight at a time; apply BEFORE merge.
- Worktrees/branches from the batch are pruned (or being pruned) — work in your OWN worktree off
  master, never `git add -A` in the shared checkout.

## Session mechanics (unchanged, still true)

Ship flow per CLAUDE.md (public window minimal, private flip is a `finally`, wait for `BUILDING`).
Local stack, prod DB access, e2e fixtures, RN-web driving, slow commits (240s), policy anchors:
see CLAUDE.md and the memory index — this file no longer duplicates them.
