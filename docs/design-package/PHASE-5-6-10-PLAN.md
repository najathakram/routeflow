# Phases 5 · 6 · 10 — Buyer Portal · Messaging · Mobile Deltas: Build Plan

> Scoped 2026-07-09 as the sequenced build plan for the three remaining Unified-Ledger
> phases. Modeled on `PHASE-4-PLAN.md` (W-chunks, one PR each). **This is a multi-month,
> multi-session program — do NOT attempt as one push.** Source of truth: `specs/*.md`
> (specs override PRDs) → `docs/design-package/project/unified/*.html` (visual+behavioral)
> → `uploads/*.md` (PRDs). Endpoint map: `specs/backend-wiring-index.md`. Every migration
> follows the **db-migration** skill + `CLAUDE_SESSION_PREAMBLE.md`; every deploy follows the
> **rebuild** routine (`npm run verify` → public→PR→CI→private → post-deploy-check).

---

## 1. Executive summary

Three phases remain, and they are **not peers** — they stack:

- **P5 Buyer Portal** upgrades an already-shipped base portal (`apps/api/src/buyer/*`,
  `apps/web/app/buyer/portal/[seller]/*`) with net-new commerce: promotions, catalogue v2,
  stock alerts, replenishment ("Your Shelf"), open-order revisions + a post-dispatch
  change-request engine, a credits wallet, check lifecycle, and statement PDFs. **Almost no
  new money primitives are invented** — credits extend `CreditNote`, change-requests extend
  `DeliveryMutation`, promos evaluate inside `pricing.ts`, statement PDFs reuse the
  `TobaccoReport` pattern. This is the highest-value track (revenue surface, self-serve).
- **P6 Messaging** is ~97% net-new but sits on **done-but-unwired plumbing**: the tenant-scoped
  `RouteFlowGateway`, `NotificationsService` push, per-tenant `EmailService`, and the entire
  `MSGS` metering chain (`msgsIncluded=200`, `MSG_BUNDLE_500`, `MeterService.increment`) all
  exist — **nothing calls them**. P6 is infra-first: schema → send engine → adapters → webhooks
  must land before any inbox or trigger.
- **P10 Mobile Deltas** is a pure API client (no new Prisma models). **Mobile mirrors web**, so
  almost every net-new P10 screen is BLOCKED on its P5/P6 web counterpart. The exception —
  **parity screens over already-shipped web APIs** (estimates, credit-notes, finance reports,
  recurring, route templates, payments ledger, buyer finances) and **regulated-operator polish**
  over shipped W6 surfaces — is unblocked TODAY and is the ideal parallel lane.

**Ordering principle (why this sequence):** (1) **backend-first within a surface** — a screen
cannot mirror an endpoint that doesn't exist; (2) **messaging infra before messaging features** —
threads/engine/adapters/webhooks are the substrate for every inbox, trigger, opt-out, meter, and
act-from-chat; (3) **mobile follows web** — never build a mobile screen before its web DTO is
merged; (4) **value × (1/risk)** orders the money-path work — promotions/credits/change-requests
carry adversarial-review cost, so they trail the safe foundations (estimates, merch flags, schema)
that unblock the most downstream work.

### Recommended BUILD SEQUENCE (each item = one branch/PR)

Three lanes run in parallel; within a lane the order is dependency-forced. Lane A (P5) and
Lane B (P6) are independent and can progress simultaneously; Lane C (P10) trails both but
opens **immediately** with its unblocked parity/regulated subset.

**Wave 0 — Foundations (parallel, no cross-deps):**
1. **P5-05** replenishment.estimates(customer) service `[start here]`
2. **P5-01** merch flags + Promotion/PromotionProduct model & CRUD
3. **P5-08** open-order editing + OrderRevision versioning
4. **P6-1** thread/message schema + generalize run-chat + migration
5. **P10-PAR-1..7** parity screens (mobile) — unblocked over shipped web APIs
6. **P10-REG-4/5/6** regulated-operator polish — unblocked over shipped W6 web

**Wave 1 — Build on foundations:**
7. **P5-04** promotions pricing at cart + checkout savings (← P5-01)
8. **P5-02** catalogue v2 shop (← P5-01, P5-05)
9. **P5-12** check lifecycle · **P5-13** credits wallet (independent money paths)
10. **P6-2** send engine (← P6-1)
11. **P6-6** settings→notifications matrix + templates (← P6-1)

**Wave 2 — Features over the engine:**
12. **P5-03** stock alerts · **P5-06** Your Shelf · **P5-07** running-low strip (← P5-02/05)
13. **P5-09** post-dispatch change-request engine (← P5-08)
14. **P5-14** payments & credits page · **P5-15** statement PDF (← P5-12/13)
15. **P6-3** WA+SMS adapters (Stub default) (← P6-2)
16. **P6-4** outbound status + inbound webhooks (← P6-3)
17. **P6-5** transactional trigger wiring · **P6-10** quiet hours · **P6-11** metering (← P6-2)

**Wave 3 — Inboxes, act-from-chat, downstream UI:**
18. **P5-10** buyer change-request UI · **P5-11** tenant change-request facilitation (← P5-09)
19. **P6-7** operator inbox · **P6-8** buyer inbox (← P6-2, P6-4) · **P6-9** opt-out/STOP (← P6-4)
20. **P6-12** act-from-chat · **P6-13** retention/export (← P6-7)

**Wave 4 — Mobile mirrors (each follows its merged web surface):**
21. **P5-16 / P10-BUY-2..11** buyer commerce parity (mobile)
22. **P10-REG-1/2/3/7/8** regulated hub + buyer regulated (mobile, ← W6/P5 web)
23. **P10-POS-1..10** POS/margin/drive-mode/guardrails (mobile, ← web guardrails)
24. **P6-14 / P10-MSG-1..4** mobile inboxes + send meter (← P6-7/8)
25. **P10-UX-1..3** onboarding + batch import + UX standards (← web onboarding/import)

---

## 2. Per-increment tables

Effort: **S** ≤ ½ session · **M** ~1 session · **L** ~1–2 sessions · **XL** multi-session /
pair-programmed. `[money]`/`[compliance]` = adversarial review + invariant gate before release.

### 2A. Shared foundation

| # | Increment | Phase | Surfaces | New models / migration | Depends on | Effort | Acceptance |
|---|-----------|-------|----------|------------------------|------------|--------|------------|
| F0 | Messaging schema foundation | P6 | api | `MessageThread`, `ThreadMessage` (generalize `Message`), `NotificationRule`, `MessageTemplate`, `MessageOptOut`, `MessagingSettings`, `InboundTriage` + `Customer.smsConsent/waConsent/consentUpdatedAt`; additive, `git add -f` the `.sql` | none | M | Migration applies on prod-baselined DB; run-chat still reads/writes via `runId` (channel=INTERNAL backfill); `forTenant()` on every model; money untouched |

*(F0 = P6-1; listed as the P6 track head. No other track requires a schema-only foundation —
P5's models are folded into their feature increments; P10 introduces zero models.)*

### 2B. P5 — Buyer Portal track

| # | Increment | Phase | Surfaces | New models / migration | Depends on | Effort | Acceptance |
|---|-----------|-------|----------|------------------------|------------|--------|------------|
| P5-05 | replenishment.estimates(customer) service | P5 | api | none (computed over Order history) | none | L | Cadence/est-days-left/suggested-qty match seeded history; suggested qty rounds to usual pack; past-cadence flags `low` |
| P5-01 | Product merch flags + Promotion model & CRUD | P5 | api, web | `Promotion`, `PromotionProduct` + `Product.isNew/isDeal` | none | L | Tenant flags featured/new/deal + windowed promo rule; buyer catalog returns flags + active promos scoped to seller |
| P5-08 | Open-order editing + OrderRevision versioning | P5 | api, web | `OrderRevision` | none (extends PATCH orders/:id/items) | L | Pre-loading edits need no approval + append a revision; countdown = real cutoff; credit/regulated/stock-violating edit blocked inline; history on timeline |
| P5-04 | Promotions pricing at cart + checkout savings `[money]` | P5 | api, web | none | P5-01 | M | Qty-break applies only at threshold; savings line at checkout; placed order/invoice use `originalPrice` strikethrough, no double-count |
| P5-02 | Catalogue v2 shop (`buyer-shop.html`) | P5 | web | none | P5-01, P5-05 | XL | Category-rail counts correct; smart collections populate; live stock + negotiated/struck price; regulated tiles locked until authorized; "Best for you" sorts by frequency; search matches SKU/barcode |
| P5-12 | Check lifecycle (Recorded→Deposited→Cleared→Bounced) `[money]` | P5 | api, web, mobile | `Payment.checkStatus/depositedAt/clearedAt/bouncedAt/nsfFeeAmount` | none | M | Deposited→Cleared reflects live on buyer view; NSF marks Bounced + fee + re-opens invoice balance |
| P5-13 | Credits wallet + auto-apply oldest-first `[money]` | P5 | api | `CreditNote.expiresAt/appliedAt/autoApplied` (extend) | none | L | Oldest open credit applies first at issue; expired never applies; balance = Σ open credits; approved dispute creates a credit |
| P5-03 | Stock alerts / Notify-me | P5 | api, web, mobile | `StockAlert` | P5-02 | M | Alert on OOS product + restock fires exactly one notification and clears the entry; operator product detail shows waitlist count |
| P5-06 | Your Shelf page (`buyer-shelf.html`) | P5 | web | `ReplenishmentSnooze` | P5-05 | L | Add-all-low seeds one cart at suggested qty; Snooze suppresses one cycle; delivery calendar shows route days/cutoffs + open order |
| P5-07 | Running-low strip + dashboard chips | P5 | web | none | P5-05, P5-02 | S | Strip/chips show same low items + suggested qty as Shelf for the same customer |
| P5-09 | Post-dispatch change-request engine `[money][compliance]` | P5 | api | `ChangeRequest` | P5-08 | XL | Post-loading edit creates a ChangeRequest (not direct edit); driver approve merges qty into delivered lines + invoice (via `DeliveryMutation`); not-on-truck approval drafts a next-delivery line; decline notifies with reason; guards re-run on approval |
| P5-14 | Payments & credits page (`buyer-payments.html`) | P5 | web, mobile | none | P5-12, P5-13 | M | Live check status per row; wallet balance matches P5-13; how-to-pay card renders tenant remittance config |
| P5-15 | Statement PDF (`GET /buyer/statements/:month`) | P5 | api, web, mobile | none (on-demand; optional `BuyerStatement` cache deferred) | P5-13 | M | PDF where opening+charges−payments−credits = closing = Finances totals; buyer downloads without 401 |
| P5-10 | Buyer change-request UI on order detail | P5 | web, mobile | none | P5-09 | M | Post-dispatch change shows PENDING on timeline; chip flips to Approved/Declined(reason) on resolution |
| P5-11 | Tenant-side change-request facilitation | P5 | api, web, mobile | none | P5-09 | M | Pending CR badges Orders + appears at matching stop on Live Dispatch/driver app; resolving there resolves the buyer's request |
| P5-16 | Mobile buyer commerce parity | P5/P10 | mobile | none | P5-02/03/06/08/10/12/13/14/15 | XL | Each mobile screen hits the same API as its web twin; passes mobile Jest pure-logic; boxed/promo/credit math matches web to the cent |

### 2C. P6 — Messaging track

| # | Increment | Phase | Surfaces | New models / migration | Depends on | Effort | Acceptance |
|---|-----------|-------|----------|------------------------|------------|--------|------------|
| P6-1 | Thread/message schema + generalize run-chat | P6 | api | see F0 | none | M | (F0 acceptance) |
| P6-2 | Send engine (channel router + template render + gating) | P6 | api | none | P6-1 | L | Picks enabled channel per event, renders vars, skips opted-out → next; refuses WA/SMS for INVOICE_SENT; unit specs cover fallback + policy |
| P6-3 | Provider-agnostic WA+SMS adapters (Stub default) | P6 | api | none | P6-2 | M | Engine sends end-to-end through StubProvider with no external account; real adapter behind env/flag; provider swap needs no engine change |
| P6-4 | Outbound status + inbound webhooks | P6 | api | none | P6-3 | L | Status callback flips message delivered/read live; known-number inbound lands in the one thread; unknown → InboundTriage; STOP → opt-out + auto-reply; signature verified |
| P6-5 | Transactional trigger wiring (event → engine) | P6 | api | none | P6-2 | L | Out-for-delivery fires configured channel with ETA+track template; disabled matrix cell suppresses; reminder/expiry crons enqueue idempotently |
| P6-6 | Settings→Notifications matrix + templates | P6 | api, web | none | P6-1 | M | Toggling a cell persists + drives real sends; template edit re-renders vars; WA-only cells show approved-template state |
| P6-7 | Operator inbox | P6 | api, web | none | P6-2, P6-4 | L | One row per customer across channels; open thread, reply on customer's channel, unread clears; new inbound appears live |
| P6-8 | Buyer inbox | P6 | api, web | none | P6-2, P6-4 | M | Buyer portal message appears in operator thread + vice-versa; WA fallback when offline; attachments via existing storage |
| P6-9 | Opt-out / STOP + consent state | P6 | api, web | none | P6-4 | S | STOP disables that channel + auto-reply; sends fall through to next; customer record shows opt-out |
| P6-10 | Quiet hours | P6 | api, web | none | P6-2 | S | 11 PM auto-send queues + releases next morning; manual send warns; window/timezone edit persists |
| P6-11 | Metering wiring (MSGS increment + cap prompt) | P6 | api, web | none | P6-2 | S | WA/SMS decrement 200/mo; email/portal/internal never metered; cap completes in-flight then inline `MSG_BUNDLE_500` prompt; packs stack |
| P6-12 | Act-from-chat write-through `[money]` | P6 | api, web | none | P6-7 | L | "Add to order…" updates order + stamps BOTH timelines; issue→credit-note real CN applied next invoice; totals via `pricing.ts` |
| P6-13 | Retention + export | P6 | api, web | none | P6-7 | S | Thread exports all messages + providerMsgIds + statuses; no auto-purge |
| P6-14 | Mobile inboxes (operator + buyer) | P6/P10 | mobile | none | P6-7, P6-8 | L | Mobile operator/buyer view threads, send, receive live + push; pure-logic Jest covers thread/send reducers |

### 2D. P10 — Mobile Deltas track (no new models; pure API client)

**Unblocked now** (over shipped web APIs) — start in parallel with Waves 0–1:

| # | Increment | Phase | Surfaces | Depends on | Effort | Acceptance |
|---|-----------|-------|----------|------------|--------|------------|
| P10-PAR-1 | Estimates / quotes (operator) | P10 | mobile | web estimates (exists) — UNBLOCKED | M | Create/list/send + convert-to-invoice via existing endpoint; money via `pricing.ts` |
| P10-PAR-2 | Credit notes (operator) | P10 | mobile | web credit-notes (exists) — UNBLOCKED | M | Issue/apply/void via API; applied credit reflects on target invoice |
| P10-PAR-3 | Finance reports (AR aging/P&L/cash flow/expense) | P10 | mobile | web finance/reports (exists) — UNBLOCKED | M | Read-only from analytics/finance endpoints; figures match web; single-column scroll |
| P10-PAR-4 | Recurring invoices (operator) | P10 | mobile | web invoices/recurring (exists) — UNBLOCKED | M | View/pause/resume schedule; next-run + generated invoices display |
| P10-PAR-5 | Route templates (operator) | P10 | mobile | web routes/templates (exists) — UNBLOCKED | M | Instantiate route from template; stops populate; pre-dispatch edits work |
| P10-PAR-6 | Payments ledger (operator) | P10 | mobile | web finance/payments (exists) — UNBLOCKED | S | Payments list filters + detail; matches web; links back to invoices |
| P10-PAR-7 | Buyer finances / statement overview | P10 | mobile | web buyer finances (exists) — UNBLOCKED | M | KPI stack + 12-mo chart + recent payments render single-column; match web |
| P10-BUY-9 | Standing orders — full template CRUD | P10 | mobile | web buyer templates (exists) — UNBLOCKED | M | Create/edit/delete template; Reorder places; Add-to-cart merges; request-a-template posts |
| P10-BUY-10 | Buyer favorites / quick-reorder | P10 | mobile | web buyer favorites (exists) — UNBLOCKED | S | Favoriting persists; quick-reorder adds all to cart in one action |
| P10-BUY-8 | Buyer order tracking timeline | P10 | mobile | web tracking + route stop events (exists) | M | Timeline w/ timestamps; live section from Socket.IO; Reorder; map placeholder (upgradeable) |
| P10-POS-2 | Sale-builder minimize / collapsed draft bar | P10 | mobile | existing sale builder (client-only) | M | Minimize preserves state; docked bar persists across tabs; scan-while-docked offers add; resume restores |
| P10-REG-4 | Sale builder — regulated handling + two-invoice summary | P10 | mobile | shipped web regulated split + shipped split-invoice | M | Unlicensed+regulated scan blocks until license/override; summary shows two grouped invoice blocks; one Create → paired invoices |
| P10-REG-5 | Invoice detail — sibling pairing | P10 | mobile | shipped web invoice pairing | S | Paired chip navigates siblings; per-invoice payment; no cross-total leakage |
| P10-REG-6 | Products list — regulation scope filter | P10 | mobile | shipped web regulation-scope param | S | Scope filters list; chip dismissible; selection persists per user |

**Blocked on P5/P6 web** — build each after its web counterpart merges (Wave 4):

| # | Increment | Phase | Surfaces | Depends on (web) | Effort | Acceptance |
|---|-----------|-------|----------|------------------|--------|------------|
| P10-BUY-1 | Your Sellers directory + Connect Seller | P10 | mobile | P5 buyer Your-Sellers + connect endpoints | M | Tap switches activeSeller → seller dashboard; connect submits pending link; suspended/pending distinct; empty-state Connect |
| P10-BUY-2 | Catalogue v2 (rich commerce catalog) | P10 | mobile | P5-02 + promotions | L | Image pager swipes; inline stepper adds without leaving grid; deal/new/behavioral chips from merch DTO; OOS → Notify-me |
| P10-BUY-3 | Stock alerts / Notify-me (mobile) | P10 | mobile | P5-03 | M | Notify-me subscribes; restock push deep-links to product; unsubscribe removes |
| P10-BUY-4 | Your Shelf replenishment (mobile) | P10 | mobile | P5-06 | L | Add-all-low → cart; snooze suppresses window; days-left bars reflect model; low-stock push deep-links |
| P10-BUY-5 | Open-order edit + change-request (buyer + driver) | P10 | mobile | P5-08/09 | L | Pre-dispatch autosave reprices via `pricing.ts`; post-dispatch → CR; driver approve merges into POD+invoice; ±$0.01 |
| P10-BUY-6 | Buyer payments & credits (checks/wallet/statement/dispute) | P10 | mobile | P5-13/14/15 + P6 (dispute routing) | M | Check chain renders; wallet + auto-applied credits shown; statement PDF shares; dispute opens prefilled thread |
| P10-BUY-7 | Buyer cart guardrails + reorder price-review | P10 | mobile | P5 cart guardrails + reorder review | M | Below-MOV submits as request; cutoff countdown blocks late; reorder review lists deltas + confirm; standing order past threshold pauses + pushes |
| P10-BUY-11 | Report an issue (buyer order line) | P10 | mobile | web report-issue/returns intake | S | Issue → seller Returns queue; photo required; credit status inline |
| P10-REG-1 | Regulated Items hub (operator) | P10 | mobile | W6/P5 tracked-categories + filings API | L | Category switch re-scopes KPIs+filings; overdue danger pill; filing detail exports/shares PDF; addon gating preserved |
| P10-REG-2 | Tracked Categories manager | P10 | mobile | P5 tracked-category CRUD | L | Create/edit persists via web CRUD; scan-to-add by barcode; invoice-treatment round-trips; deactivate preserves history |
| P10-REG-3 | Product form — regulated picker + license/override sheets | P10 | mobile | P5 product regulated field + license/override + authorization endpoints | M | Regulated field on create+edit+quick-create; override writes audit + reminder; approve/reject flips authorization w/ doc preview |
| P10-REG-7 | Driver regulated POD (signature + ID-check) | P10 | mobile | P5 category delivery rules (requires_signature/id) | M | Regulated stop can't leave-at-door; signature mandatory; ID/age prompt only when category requires; recorded on POD |
| P10-REG-8 | Buyer regulated visibility + Licenses & Authorizations | P10 | mobile | P5 buyer regulated (auth lifecycle, catalog gating, submit/renew, cart split) | L | Unverified never sees addable regulated; verify unlocks + propagates to all sellers; expiry re-locks + skips standing lines; two-block cart split, one Place Order |
| P10-POS-1 | Live cost/margin in sale builder | P10 | mobile | P5 POS cost/margin surfacing | M | Margin recomputes; below-floor red + "Set to floor"; cost tap → lot/bill history; boxed lines never re-derive qty×unitPrice |
| P10-POS-3 | At-the-door sheet (arrived stop) | P10 | mobile | P5/pos at-door flow | M | At-door edits flow to POD in ≤2 taps; Collect payment prefilled; works offline |
| P10-POS-4 | Drive mode toggle + field-first layout | P10 | mobile | role matrix (pos-cost-roles-spec) | L | Toggle switches layout without losing drafts/session; scanner FAB reachable; admin-only areas hidden for pure drivers |
| P10-POS-5 | Owner-operator home | P10 | mobile | P10-POS-4 | S | admin+driver see run card above KPIs; single-role see standard home |
| P10-POS-6 | Operator credit-limit guard (sale sheet) | P10 | mobile | web credit-limit guard (guardrails-spec) | S | Over-limit surfaces guard; Proceed logs override; Collect routes to payment; Cancel aborts |
| P10-POS-7 | Short-pick check (loading) | P10 | mobile | web short-pick guardrail | M | Deliver-short reprices via `pricing.ts`; substitute swaps line; totals reconcile ±$0.01 |
| P10-POS-8 | Failed-delivery sheet (driver) | P10 | mobile | web failed-delivery guardrail | S | Reason + photo required; retry/reschedule/restock route; works offline |
| P10-POS-9 | Run settlement sheet (driver) | P10 | mobile | web run-settlement guardrail | M | Variance highlighted; close blocked until reconciled/overridden; totals match collected ±$0.01 |
| P10-POS-10 | Offline sync-review + duplicate-hint | P10 | mobile | web duplicate-detection endpoint | M | Conflicting queued mutations surface with resolve choices; duplicate hint offers Open existing / Create anyway |
| P10-MSG-1 | Operator Messages tab (unified threads) | P10 | mobile | P6-7 | L | Threads list all channels + unread; quick-reply chips open prefilled sheets; send via P6 engine; run-chat alongside WA/SMS/portal |
| P10-MSG-2 | Buyer Messages (single seller thread) | P10 | mobile | P6-8 + adapters/webhooks | M | Buyer messages active seller w/ photo; outbound mirrors to WA when offline; dispute-a-line lands prefilled |
| P10-MSG-3 | Notification settings summary + per-device push | P10 | mobile | P6-6 + quiet-hours | S | Matrix read-only; per-device toggles register/unregister Expo push; quiet-hours suppresses auto-sends |
| P10-MSG-4 | Send meter + pack prompt in send sheet | P10 | mobile | P6-2 + MSGS meter | S | Send sheet shows remaining quota; cap blocks + pack prompt; MSGS meter increments on send |
| P10-UX-1 | First-run onboarding checklist + Start migration | P10 | mobile | web onboarding/migration state | M | Checklist steps persist; mirror web state; Start-migration deep-links import |
| P10-UX-2 | Batch invoice import (camera multi-capture) | P10 | mobile | P5/import batch-import queue + variant resolution | L | Multi-capture enqueues server-side; completion push → review sheet; only flagged lines; variant three-choice auto-suggests SKUs |
| P10-UX-3 | Mobile UX standards (Undo / session-expiry / i18n) | P10 | mobile | web UX standards (migration-import-spec §H) | M | 8s Undo on reversible actions; session-expiry PIN/biometric keeps drafts; en/es toggle switches driver+buyer strings |

---

## 3. Cross-cutting rules (honor on EVERY increment)

- **Tenant scoping** — every new model + query goes through `prisma.forTenant()`; JWT
  `tenantId`/`role` is the boundary. Buyer surfaces additionally use the `BUYER_KEYS`
  token-isolation + `BuyerTenantInterceptor` (RF-220). No cross-tenant leakage in threads,
  promos, credits, alerts, or statements.
- **Money via `pricing.ts` (triple mirror)** — all line/tax/total math flows through
  `computeLineSubtotal` / `normalizeBoxesPieces` / `roundMoney` in
  `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`. **Round every monetary write**; never
  re-derive `qty × unitPrice` for a boxed line. Promotions, credits auto-apply, change-request
  merges, check NSF fees, and statement math all obey this. Add regressions to the
  `pricing.spec.ts` mirror set. The discount convention is **net `unitPrice` + `originalPrice`
  strikethrough + `discount:0`** — never re-derive discount from `originalPrice` (double-counts).
- **Additive, reversible migrations** — extend don't fork: `CreditNote`/`Payment`/`Product`
  gain columns, `Message`→`ThreadMessage` generalizes with a backfill, run-chat keeps its
  `runId` path. Repo-wide `*.sql` gitignore means **`git add -f` every new `migration.sql`** or
  it never reaches prod. Prod applies only via `railway run npx prisma migrate deploy`
  (or the Postgres-proxy script per MEMORY) — never auto-migrate, never `--force-reset`.
- **Undo standard** — reversible mutations show an **8s Undo snackbar**; confirm sheets are for
  irreversible actions only (P10-UX-3 makes this a cross-cutting mobile rule; apply the same
  spirit on new web mutations — snooze, add-all-low, favorite, opt-out toggle).
- **Plan-gating / entitlements** — messaging is metered on the **existing** `MSGS` chain
  (`msgsIncluded=200`, `MSG_BUNDLE_500`, `MeterService.increment(tenantId,'MSGS',n)`): only WA+SMS
  increment; email/portal/internal never do; cap **completes the in-flight send** then prompts a
  pack inline (mirror SCANS). Buyer portal + regulated remain addon-gated (`BUYER_PORTAL`,
  `REGULATED_ITEMS`); reuse `useHasAddon`/`EntitlementsService`, never hardcode a flag.
- **Mobile mirrors web** — same endpoints/DTOs/flows, UI-only difference. **Never build a mobile
  screen before its web DTO merges.** Keep the mobile `pricing.ts` mirror in sync in the same PR
  that changes the API/web mirror. Mobile tests are **pure-logic Jest only**.
- **Release gates** — `npm run verify` + smoke + `post-deploy-check` on every deploy (rebuild
  routine, standing). `[money]`/`[compliance]` increments (P5-04/09/13, P5-12, P6-12) require an
  adversarial `/code-review high` focused on per-invoice ±$0.01 and the boxed-line × promo/credit
  interaction, plus an E2E invariant in `06-critical-paths.spec.ts` before release.

---

## 4. Gating decisions (consolidated, prioritized)

**BLOCKS** = must be answered before the named increment can start. Recommended defaults are
chosen to keep the first increment unblocked; unless overridden, build proceeds on the default.

| # | Decision | Recommended default | Blocks / defer |
|---|----------|---------------------|----------------|
| G1 **(headline)** | **Messaging provider** — Meta WhatsApp Cloud vs Twilio WA vs BSP; SMS provider | **Meta WA Cloud + Twilio SMS, behind a provider-agnostic `MessageProvider` interface**; decouple so a tenant could later use Twilio for both. Sets webhook shape, template-approval flow, credential fields | **BLOCKS P6-3/P6-4** (not P6-1/P6-2). Decide before Wave 2 |
| G2 | Ship a **StubProvider first** vs integrate real provider immediately | **Yes — StubProvider is the default adapter in P6-3; real adapter behind env/feature flag.** Lets engine/inboxes/matrix/metering/opt-out/quiet-hours/act-from-chat all build+test+deploy at $0 | Defer real-provider wiring; does NOT block the P6 chain |
| G3 | **Generalize run-chat `Message`** vs parallel customer-thread model | **Generalize → `ThreadMessage` (channel=INTERNAL for run-chat, `threadId` nullable, `runId` retained).** One realtime+storage substrate | **BLOCKS P6-1 (F0)** — decide first thing in the P6 lane |
| G4 | **Credits wallet** — new `StoreCredit` ledger vs extend `CreditNote` | **Extend `CreditNote` (`expiresAt/appliedAt/autoApplied`); balance = Σ open credits.** A parallel ledger forks money truth | **BLOCKS P5-13** |
| G5 | **Credits auto-apply** timing + partial-payment / discount interaction | **Automatic oldest-first at invoice issue, capped at invoice total, recorded as an application; never re-derive discount from `originalPrice`** | **BLOCKS P5-13** (same increment as G4) |
| G6 | **Change-request authority** — driver-at-stop vs office vs both; conflict resolution | **Driver-at-stop primary; office resolves only while PENDING; first resolution wins + locks; guards (credit/regulated/stock) re-checked on approval** | **BLOCKS P5-09** |
| G7 | **Order edit window** — what event closes free editing / opens change-requests | **Tie to the `RouteRun` load/dispatch transition for the order's stop; countdown from the per-day cutoff in routes config** | **BLOCKS P5-08/P5-09** — one authoritative timestamp |
| G8 | **Promotion rule expressiveness** — typed set vs JSON DSL | **Typed set: PERCENT / FIXED / QTY_BREAK, scope ALL\|CATEGORY\|PRODUCTS, windowed; evaluate in `pricing.ts`** | **BLOCKS P5-01** |
| G9 | **Notify-me channel** now that WA/SMS adapters (P6) are unbuilt | **Push-only in P5-03; add WA/SMS fan-out when P6 adapters land** | Defer WA/SMS fan-out; does NOT block P5-03 |
| G10 | Behavioral chips + "Best for you" data source | **Reuse the operator forecasting engine as a per-customer slice inside `replenishment.estimates`; chips + sort read the same frequency data** | Non-blocking; shapes P5-05/P5-02 |
| G11 | **Statement PDF** — on-demand vs cached `BuyerStatement` | **On-demand for the requested month (no persistent model in v1); add cache only if cost shows** | Non-blocking; keep `BuyerStatement` model out of P5-15 v1 |
| G12 | **Invoice channel policy** — EMAIL + mark-as-sent only? | **Yes — hard-enforce in the send engine; WA/SMS invoice cells render disabled** | **BLOCKS P6-2/P6-5** (engine-level, not just UI) |
| G13 | **Quiet-hours** default + auto-vs-manual behavior | **21:00–07:00 tenant-local; auto queues+releases next morning, manual warns-and-confirms** (needs a scheduled-release mechanism — reuse billing-cron) | **BLOCKS P6-10** |
| G14 | **Unknown-number inbound** — auto-create vs triage | **Triage queue (`InboundTriage`) with link/create honoring existing dedupe; never auto-create silently** | **BLOCKS P6-4** |
| G15 | Which **parity screens** on mobile vs web-only | **Build PAR-1..7 (on-road value, reuse existing APIs); keep bookkeeping + settings-CSV-import web-only** | Non-blocking; scopes the P10 parity lane |
| G16 | P10 **sequencing** — start now or blocked? | **Start PAR-1..7 + regulated-operator polish (REG-4/5/6) + tobacco→hub generalization NOW; defer buyer-commerce / messaging / buyer-regulated / drive-mode until the P5/P6 web surface merges** | Non-blocking; already the Wave plan |
| G17 | **Map / native constraints** for tracking + drive-mode | **Static map placeholder first, upgrade to `react-native-maps` later; test via dev-client build + mobile-web PWA proxy (Expo Go can't run it)** | Non-blocking |
| G18 | Buyer commerce **delivery surface** — Expo `(customer)` vs separate PWA | **Deliver in the existing Expo `(customer)` route group; web buyer portal is the PWA fallback — not a second codebase** | Non-blocking |

**Decide-before-you-start-a-lane:** G3 + G8 + G7 (open the P5 and P6 lanes), G4/G5 + G6 (open the
money-path increments). **G1 is the headline but is NOT a Wave-0 blocker** — it can be resolved
while F0→P6-2 build against the Stub (G2), and only gates P6-3/P6-4.

---

## 5. Start here — the first increment

**P5-05 — `replenishment.estimates(customer)` service** `[api]` `[Effort L]`

Chosen because it is the **highest-value, lowest-dependency, zero-blocking-decision** increment:
no upstream deps, no migration, no money-write, and it **unblocks three downstream surfaces**
(Your Shelf, shop "Running low" strip, dashboard chips) plus the behavioral chips + "Best for you"
sort in the catalogue-v2 shop. It is a pure computation over existing `Order` history reusing the
operator forecasting slice — safe to ship, immediately testable with seeded data.

**File-level scope:**
- **New service** `apps/api/src/buyer/replenishment.service.ts` (or fold into
  `buyer-catalog.service.ts` if the module prefers) — one method
  `estimates(customerId, tenantId): ReplenishmentEstimate[]` computing per-product **cadence**
  (qty/interval from `Order`/`OrderItem` history), **last-ordered**, **est. days-left**
  (cadence ± seasonality), **suggested-qty** (rounded to the buyer's usual pack via
  `normalizeBoxesPieces`), and **low/OK state** vs the per-day cutoff.
- **Reuse, don't reinvent** the operator forecasting engine as a per-customer slice (G10) — locate
  it via the code map (`.claude/code-map/INDEX.md` → `api.md` → forecasting/analytics area) and
  call it rather than writing a second frequency computation.
- **Controller** — add `GET /buyer/replenishment` to `apps/api/src/buyer/buyer.controller.ts`
  (buyer-auth scoped, `BuyerTenantInterceptor`), returning the estimate list for the active seller.
- **DTO** — `apps/api/src/buyer/dto/replenishment.dto.ts` (`class-validator`), typed estimate shape.
- **Types** — mirror the estimate DTO into `packages/types` if buyer web/mobile will import it.
- **Tests** — `apps/api/src/buyer/replenishment.service.spec.ts`: cadence math on seeded history,
  suggested-qty rounds to usual pack (boxed), past-cadence product flags `low`. Jest,
  `Test.createTestingModule`, mock at the module boundary — no snapshots.
- **No migration.** No `pricing.ts` write path (read-only math), but use `normalizeBoxesPieces`
  for the pack rounding so mobile/web mirror it later.
- **Code map** — after the change, surgically update `.claude/code-map/api.md` (new
  `replenishment.service` entry + `buyer.controller` route) and bump `_meta.json`.

**In parallel** (also unblocked, no blocking decision beyond their defaults): **P5-01** (once G8 is
accepted), **P6-1/F0** (once G3 is accepted), and the entire **P10-PAR-1..7** mobile parity lane.

---

## 6. Rough size

- **~57 increments/PRs** across the three tracks: **P5 = 16**, **P6 = 14**, **P10 = 27** distinct
  mobile increments (the extract's 43 P10 line-items collapse — several are single screens grouped
  per PR, and P5-16 is the umbrella for the BUY mobile mirrors). Call it **≈55–60 branches/PRs**.
- **Effort roll-up:** ~6 XL, ~15 L, ~22 M, ~14 S. At the repo's **one-task-per-session** cadence
  with a deploy per phase, budget **≈70–90 working sessions** and **≈55–60 deploys** (one per PR;
  money/compliance PRs add an adversarial-review pass, and each migration adds a manual prod-apply
  gate). This is a **multi-month program**, not a sprint.
- **Critical path** (longest dependency chain, roughly serial):
  `P6-1 → P6-2 → P6-3 → P6-4 → P6-7 → P6-12 → P6-14/P10-MSG-1` — the messaging spine is the pacing
  item; everything buyer-side (P5) and the mobile parity lane (P10-PAR) run beside it, so wall-clock
  is set by whichever of {P5 money-path, P6 spine} the team staffs first, not by their sum.
- **De-risking:** front-load the safe foundations (P5-05, P5-01, F0, P10-PAR) to bank visible
  progress while G1 (provider) and G4–G7 (money-path defaults) are ratified; hold the XL
  money/compliance increments (P5-09, P6-12) for their own pair-programmed sessions with the
  invariant gates green.

## File anchors

`apps/api/prisma/schema.prisma` (Product ~807, Order ~1025, OrderItem ~1084, DeliveryMutation ~1130,
Payment ~1236, CreditNote ~1801, Message ~2088, BuyerFavorite ~2259, TobaccoReport ~2287,
PlanDefinition.msgsIncluded ~510, MeterKey ~54) · the `pricing.ts` triple mirror
(`apps/{api/src/common,web/lib,mobile/lib}/pricing.ts`) + `apps/api/src/common/pricing.spec.ts` ·
buyer API `apps/api/src/buyer/*` · buyer web `apps/web/app/buyer/portal/[seller]/*` +
`apps/web/lib/api/buyer.ts` + `apps/web/lib/buyer-cart.ts` · run-chat `apps/api/src/messages/*` ·
realtime `apps/api/src/gateways/routeflow.gateway.ts` + `redis-io.adapter.ts` · push
`apps/api/src/notifications/notifications.service.ts` · email/encryption `apps/api/src/email/*` ·
metering `apps/api/src/billing/meter.service.ts` + entitlements/subscription services · mobile
`apps/mobile/app/(operator|driver|customer)/*` + `apps/mobile/lib/api/*` · designs
`docs/design-package/project/unified/{buyer-shop,buyer-shelf,buyer-order-edit,buyer-payments,buyer-standing,buyer-product,messages,buyer-messages,settings-notifications,action-modals,live-dispatch}.html`
· specs `specs/{buyer-experience-spec,backend-wiring-index}.md`.
