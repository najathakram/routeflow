# Delivery plan — the first five customers

**Written 2026-09-13 by the fleet lead. Owner's requirements, in the owner's order:**
1. The back office must be **perfect** — we are onboarding our first five customers.
2. Then fix the bugs.
3. Then improve the tool so it can be pitched to prospects.

**Constraints:** as fast as possible, at lower cost than today. Companion files:
`waves/waves.json` (authoritative task lists), `waves/README.md` (the contract),
`../superpowers/plans/2026-09-13-backoffice-waves.md` (why the waves are ordered as they are).

---

## 1. Where we actually are — resolved, not raw

The registry's raw `state` field overstates open work by ~2×. Resolved through `status/F##.jsonl`
(the registry's own truth) on 2026-09-13:

| | Raw rows said | **True** |
|---|---|---|
| Open bugs | 393 | **220** |
| Open critical | 39 | **7** |
| Open high | 135 | **56** |

**Batches F02–F18 are essentially all done.** That is the money-loop core — orders, invoices,
delivery money, returns, scan, billing plan change, impersonation — fixed and landed. The
platform is in far better shape than the raw numbers suggest, and several items the earlier
wave plan listed as open (B58, B107, B123, B124, B125) were already fixed. `waves.json` is corrected.

**The seven open criticals**, and their state:

| Id | Batch | What | State |
|---|---|---|---|
| B305 | F38 | Driver at-door amount due is pre-tax — every cash stop under-collects | **in flight — PR #710** (blocked on one seam fix, then merges) |
| B349 | F47 | Google OAuth link state unsigned — anyone can attach their Google identity to any user | **built** in routeflow-f2's auth batch, unpushed |
| B310 | F39 | A customer advance can be spent twice — wallet debit takes no lock | queued (parked carve-out, standing go) |
| B294 | F36 | Order-derived and estimate-converted invoice lines carry `taxRate 0` | queued (parked carve-out) |
| B297 | F36 | Order edits re-price already-invoiced excise at today's rate | queued (parked carve-out) |
| B323 | F42 | Hourly pending-order sweep runs with **no tenant context** — winner tax from another tenant | queued (parked carve-out) |
| B283 | F34 | DRAFT→PENDING never reserves stock; later cancel credits stock never taken | queued (parked carve-out) |

**Finished but not in production** — roughly eight units of done work sitting unmerged:
#708 (bookkeeping), #709 (approach docs), #710 (F38, seam fix in flight), #711 (F27, hygiene in
flight), routeflow-03's billing branch (TRIAL-1 / RO-1 / STRIPE-CANCEL-1 / quote allowlist — 18
commits, three Opus rounds, held), routeflow-f2's auth batch (B349 + five findings, committed),
routeflow-0d's B394/B395 filing, and the back-office spec + Phase 0 plan + waves (this directory).

**The diagnosis that drives everything below:** the system is **landing-constrained, not
building-constrained.** One owner merge pass per window, currently frozen for review. Six
concurrent sessions today produced two duplicate bug ids, two stray writes into the shared
checkout, a mutual stop-hook deadlock, and a lead spending most of its turns on coordination.
Adding builders makes this worse. Every unmerged branch is cost with zero value and rising
conflict risk.

---

## 2. What each requirement actually needs — scoped to five customers

### Requirement 1 — "back office perfect"
For five customers, *perfect* is narrow and concrete. Each of them must be able to:
- be created on the right plan (Phase 0 T10/T14 — live catalog in the plan picker, `PLAN_KEYS` validation),
- trial → subscribe → pay, and cancel cleanly (03's billing branch: TRIAL-1, RO-1, STRIPE-CANCEL-1, `/billing/quote`),
- be billed correctly month over month (wave W1 remainder: B327 dunning that never fires, B342 double add-on, B216 armed downgrade, B218 STARTER shadow, B329 anchor drift, the unfiled admin `updatePlan` no-proration path),
- never see another tenant's data (B323 — the one open cross-tenant critical),
- and the owner must see **true** numbers for them (Phase 0 T9 one MRR engine, T11 reconciliation).

**What "perfect" does not need for five customers:** Phases 1–6, Tenant 360, a health score, a
plan editor, HQ invoicing, lifecycle email campaigns. Those are for fifty customers. Building them
now delays the five.

### Requirement 2 — "fix the bugs"
Five open criticals not yet in flight, all in parked carve-out batches that already carry standing
go (DECIDE-30, gates a–d). Then the 56 highs, by customer impact. The "393 bugs" framing was wrong;
this is a bounded list.

### Requirement 3 — "pitch-ready"
What a prospect sees in a thirty-minute demo. From the K-HUB Gap Ledger, the demo-visible subset
of the 83 one-sentence fixes — not the Location model, not the storefront builder, not i18n.
Those are quarter-scale projects; a prospect never sees them in a demo.

---

## 3. The flow

### Phase A — LAND · now → +24 h · zero new building
Get the eight finished units into production. This is the whole job for the next day.

1. routeflow-03 fixes the #710 excise seam → **independent** Opus re-review of the delta → #710 ready.
2. routeflow-90 clears #711's two hygiene blockers (root scratch files, test-identity commits) + adds the end-to-end `DECLINED → ACCEPTED` test → #711 ready.
3. **Owner pastes block A** (docs first, code last — one deploy): #708, #709, #710, #711.
4. Post-deploy, in this order: 90 proves B15/B394 (T2, needs prod Playwright) → 03's #710 bookkeeping follow-up → 90's #711 follow-up.
5. Next window: 03 pushes the billing branch → independent pre-merge review → merge. Closes TRIAL-1/RO-1/STRIPE-CANCEL-1.
6. f2's auth batch, when its user releases it → independent review → merge. Closes **B349 (critical)**.
7. 0d rebases, re-derives the next free id, renumbers its B394, files everything waiting (its two rows + 03's ten + f2's five + `ADMIN-UPDATEPLAN-1`).

**Exit criterion:** zero finished-but-unmerged work; two criticals closed (B305, B349); freeze lifted.

### Phase B — BACK OFFICE · days 2–6 · lane A only
Wave **W1** remainder, then wave **W2** (Phase 0), in that order — reconciliation must not run
against billing writes that are still wrong.

- **W1 remainder** (one PR, file-local): B327, B342, B216, B218, B329, `ADMIN-UPDATEPLAN-1`. Money carve-out: red-first per row, one in-lane Opus refute, one independent pre-merge.
- **W2 = Phase 0**, split into two sessions on its own seams, not one:
  - **W2a — schema + classification:** T1 (migration, owner-gated window), T2, T3 (dry run reviewed by owner), T8.
  - **W2b — truth + house tenant:** T4–T6, T9 (one MRR engine — fixes the $499-vs-$0 split), T10, T11 (reconciliation, owner signs the dry-run diff), T12–T15. T7 is consumed from the billing branch, not rebuilt.
- **B323** (cross-tenant sweep, critical) rides in this phase — it is a back-office trust issue for real customers, not a generic bug.

**Exit criterion:** the five customers can be created, billed, cancelled, and seen truthfully; the admin dashboard's numbers are derived, not estimated.

### Phase C — CRITICAL & HIGH BUGS · days 4–10 · lane B, overlapping Phase B
Independent files from lane A, so it runs alongside. Order by customer impact:

1. **F39** (payments/wallet, 6 rows, B310 critical — a customer advance spent twice).
2. **F36** (invoice tax, 7 rows, B294 + B297 critical).
3. **F34** (stock reservation, 5 rows, B283 critical).
4. Then the 56 highs, grouped by file locality into ~4 PRs. Not by batch label.

Each batch: hand-fixed, red-first, one in-lane refute, one independent pre-merge. No engine.

**Exit criterion:** zero open criticals; highs down to the long tail.

### Phase D — PITCH-READY · week 3 onward · lane C opens
Only once Phases A–B have landed. Order by what a prospect sees:

1. **Demo-visible little things** from the Gap Ledger (roughly ten): paste-a-list bulk order entry; products-and-units summary line; invoice send toggles (hide cost / MSRP / balance); returns tab on the customer page; available-credit tile; reorder-list-to-PO button; "Generate description" button reusing the existing Claude client; hero tagline + banner on the buyer shop; a Quick Order shortcut into Your Shelf; a weekly emailed P&L via one `@LeaderCron`.
2. Wave **W3** (admin seat: B138, B140, B165, B173 — the F33 rows are done) — sales-questionnaire material.
3. Then ROAD by dependency: lot expiry (ROAD-90 — one nullable column first), then the rest.

**Exit criterion:** a thirty-minute demo has no moment where we say "we don't have that yet" for something K-HUB shows.

---

## 4. The cost model — seven rules, each with today's evidence

1. **Landing sets the build rate.** If the owner can run two merge windows a day, that is ~8 PRs a day. Build no more than lands. Today's evidence: eight finished units idle while sessions kept building.
2. **Three lanes maximum** (A: back office, B: bugs, C: pitch — C only after A–B land). Six sessions today cost two id collisions, two stray writes, one deadlock, and most of the lead's turns.
3. **Review = one in-lane refute + one independent pre-merge, not three in-lane.** #710 had three in-lane Opus rounds and still shipped a money seam; one independent pass found it in minutes. Four Opus passes where two do better.
4. **Bugs by hand, features by engine.** The F27 engine run went multi-hour, resumed, reported complete over five red tests, and silently rewrote a test; the hand-fix landed in about an hour. F38's raw run cost $75.57 and still missed the seam. The engine earns its keep on fully-specced features, not bug batches.
5. **No cloud sessions until the train runs.** They can't run the compose boot gate, can't be steered mid-run, and would only add to the unmerged pile. Revisit in Phase D for the disjoint web little-things.
6. **Model routing, enforced:** Sonnet builds and verifies; Opus gives the independent pre-merge verdict and nothing else; Fable rules and never edits. Every subagent gets an explicit model and effort.
7. **Sessions live in their worktrees, never the shared checkout.** Half of today's coordination cost was stop hooks tripping on other sessions' uncommitted files.

---

## 5. What we deliberately do not do until the five customers are landed

- Phases 1–6 of the back-office spec. Tenant 360. The plan editor. HQ invoicing.
- The Location model, lot/FEFO beyond the first column, the storefront builder, i18n.
- Platform-admin MFA as a project — B349's signed OAuth state is the right-sized fix for five customers.
- The 83 little things in bulk — only the demo-visible ten, in Phase D.
- Launching cloud sessions. Launching a fourth concurrent lane. Re-running any engine on a bug batch.

Everything above is real, already filed in ROAD, and stays there. It is deferred, not dropped.
