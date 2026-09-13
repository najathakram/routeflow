# Back-office delivery plan — waves B1–B6

**Status:** proposed 2026-09-13 by the fleet lead. Supersedes nothing; it *sequences* work that
already exists as specs, plans and registry rows but has never been ordered.

**Companion documents (all still authoritative for their own content):**

- `docs/superpowers/specs/2026-09-12-platform-backoffice-design.md` — the umbrella design (house tenant, Phases 0–6)
- `docs/superpowers/specs/2026-09-12-backoffice-phase-0-truth-design.md` — Phase 0 design
- `docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md` — Phase 0's own 15-task plan (= wave B2)
- The published K-HUB Gap Ledger — competitive gaps, 83 one-sentence fixes
- `.claude/campaign/bugs.jsonl` — the registry rows named below

---

## 1. Diagnosis — why this work has not been getting done

It is not unplanned. It is **unsequenced, and sliced along the wrong axis.**

46 open registry bugs touch the back-office domain. Almost none of them are unowned — they are
spread across **nine different batches** (F14, F18, F19, F20, F29, F32, F33, F42, F45), each of
which also contains unrelated work. There is no batch whose subject is "the back office", so:

- No single run ever makes the admin surface materially better; each batch improves one corner.
- Running any one of them drags in unrelated files, so none of them looks cheap enough to start.
- The work stays invisible in aggregate — 46 bugs read as "scattered", not as "the platform's
  own control plane is broken".

Meanwhile the ROAD project holds 20 back-office / competitive items (ROAD-76…ROAD-95) as a **flat
list with priority labels but no order**, including ROAD-77 "Phases 1–6" as a single lump. Priority
labels do not sequence work: three items marked `high` that block each other still need an order.

**This document supplies the missing axis: waves cut by domain and dependency, not by batch.**

---

## 2. The ordering rule

Waves are ordered by one principle, applied strictly:

> **Money that is wrong → numbers that are wrong → the seat that operates on them →
> the lifecycle around them → what we sell → what we show.**

You cannot manage tenants from numbers you do not trust (so truth precedes features), and you
cannot trust numbers produced by billing writes that are themselves wrong (so money precedes
truth). Everything else follows from that.

---

## 3. The waves

### Wave B1 — Money that is wrong today
**Rule:** money moves incorrectly, or entitlements do not match what was paid for. Nothing here is
cosmetic; every row is a real over- or under-charge.

| Item | Sev | Batch | What is wrong |
|---|---|---|---|
| **B58** | critical | F18 | Admin "Change plan" always calls `subscribe` — full non-prorated charge **and** a reset billing period. Every admin-initiated plan change overcharges. |
| **B107** | high | F18 | `disableAddon` nulls `stripeItemId` even when the Stripe delete failed — the tenant keeps paying for a disabled add-on, and the pointer to stop it is gone. |
| **B342** | medium | F45 | Enabling a priced add-on twice creates two Stripe subscription items and keeps one pointer — double billing, one handle. |
| **B327** | high | F42 | The 3-day payment-grace suspension can never fire — non-payers are never suspended. |
| **B329** | low | F42 | `rollCycles` drifts the billing anchor day and drops period time-of-day. |
| **B216** | high | *none* | Reinstating a lapsed tenant does not clear a downgrade armed before the lapse — it fires later against a paying tenant. |
| **B218** | low | *none* | `subscribe()` on an off-catalog published plan key writes `currentPlan` as the STARTER enum shadow — wrong entitlements, silently. |
| *in flight* | — | — | **TRIAL-1** (trial tenant cannot cancel), **RO-1** (READ_ONLY invisible in UI), **STRIPE-CANCEL-1** (in-app cancel never propagates to Stripe), `/billing/quote` READ_ONLY allowlist — all built and held in `rf-billing-trial` (routeflow-03). |

**Money carve-out applies to every row: Opus refute-first review is mandatory, and no data repair
inside a fix.** Two separate money-direction errors were caught by that gate on 2026-09-13 alone.

**Note on B216:** adjacent to the in-flight lane (`onCheckoutCompleted` / armed-downgrade
semantics). Fold it into that lane if it lands before B1 starts; otherwise it heads B1.

---

### Wave B2 — Truth (= Phase 0, already fully planned)
**Rule:** every number the admin surface shows must be derived, not estimated, and every tenant
must be classifiable. This wave is **already written** as a 15-task plan — do not re-plan it.

Contents: `TenantClass` enum + migration · `classifyTenantSlug` + dark backfill ·
`TRIAL_LENGTH_DAYS` · device-info threading through Google OAuth · `updateTenantClass` endpoint ·
**one MRR engine** (`MrrService` exported, class-scoped, retires the `getStats()` estimator — this
is what fixes the $499-vs-$0.00 split) · `CreateTenantDto` plan validation ·
**subscription-set reconciliation** (owner signs off a dry-run diff) · house-tenant bootstrap ·
`TenantMirrorService` · web plan picker + MRR field rename · full verification.

**Depends on B1.** Reconciling the subscription set while the billing writes that produce it are
still wrong reconciles to wrong values. Task 7 (`/billing/quote` allowlist) is **already
reassigned** to the in-flight billing lane — consume it, do not rebuild it.

**Carries the only migration in the programme.** It is owner-gated and runs in its own window.

---

### Wave B3 — The admin seat: impersonation and isolation
**Rule:** an admin acting on a tenant must not leak across tenants, and must be auditable.
**This wave is independent of B1/B2 files and should run in parallel from day one.**

| Item | Sev | Batch | What is wrong |
|---|---|---|---|
| **B124** | high | F33 | Impersonation keeps the previous tenant's logo, business name and username. |
| **B138** | high | F14 | Signing out during impersonation deletes every refresh token of the *real* tenant admin. |
| **B165** | medium | F14 | The impersonation guard can never fire — impersonated writes are audited as the tenant's own admin. Audit is blind precisely when it matters most. |
| **B173** | low | F29 | An impersonation timeout bounces the admin silently and leaves the tenant cookie set. |
| **B140** | high | F19 | Mobile sign-out never clears the query cache — the next tenant sees the previous tenant's figures. |
| **B123** | high | F33 | Developer Mode silently overrode per-tenant delivery toggles and the dispatch API. |
| Phase 2 | — | — | Platform-admin MFA + recovery; **B349** signed OAuth state (already built in another lane — land it, do not rebuild). |

---

### Wave B4 — Tenant lifecycle completeness
**Rule:** every state a tenant can reach has a way out, and somebody is told when it is reached.
**Depends on B2** (needs `Tenant.class` and trustworthy states).

- **CANCELLED is a dead end** — 403 on every method *including GET*, no banner, no CTA; only a
  platform-admin `updateStatus` restores. **This is a gating precondition: do not enable Stripe
  checkout for any real tenant until CANCELLED has a path back** (self-serve resubscribe, or at
  minimum read-only data access + support CTA). The STRIPE-CANCEL-1 fix makes this state reachable
  by a self-service click.
- **B217** (medium) — a scheduled downgrade deactivates every seat over cap with no way to choose.
- **B219** (low) — a failed re-quote on choose-plan clears the summary card with no error toast.
- **B125** (high, F33) — tenant admins auto-created as drivers; deleting the driver row rolls back.
- **B95** (low, F20) — the mobile tenant-admin dashboard is unreachable; no role routes there.
- **Phase 4 lifecycle messaging** — event-triggered emails on the existing `notify()` engine, owner
  alerts, and the **legacy READ_ONLY-with-live-Stripe cohort alert** (currently a log warn nobody
  reads). Needs the real transport from ROAD-84.

---

### Wave B5 — What we sell (= Phase 3)
Draft/publish plan editor · pricing consistency across catalog and checkout · the GoHighLevel
$9.99 SKU. **Depends on B2** (a plan editor over untrustworthy plan data is a liability).

---

### Wave B6 — What we show (= Phases 5–6)
Tenant 360: merged timeline, contacts, tasks, health score, attention queue. Tenant portal:
self-serve card/invoice, credits, **export/erasure** — which also discharges the contractual
data-export guarantee in ROAD-79 and answers the CANCELLED data-access problem from B4.

---

## 4. Execution model — how this goes fast

**Two lanes, not six.** The waves are a sequence, but not a single-file queue:

```
Lane A (serial spine):   B1 ──▶ B2 ──▶ B4 ──▶ B5 ──▶ B6
Lane B (parallel):       B3 ─────────────────▶ (lands whenever ready)
```

- **B3 runs from day one alongside B1.** It touches auth/impersonation/mobile-session files; B1
  touches `billing/*`. Disjoint — no worktree contention, no merge conflicts.
- **B1 → B2 is the one hard serialization.** Reconciliation must not run against wrong writes.
- **B4/B5 both depend on B2 only**, so they can split into two lanes once B2 lands.

**Per-wave gates (non-negotiable):**
1. Red-first regression proving the *wrong value*, per registry row.
2. Money carve-out on B1, B2's reconciliation, and B5: **Opus refute-first review, mandatory.**
3. No data repair inside a bug fix. Reconciliation is a separate, owner-signed, dry-run-first step.
4. Compose boot gate before push on anything touching module wiring.
5. One PR per wave segment, not per bug — batch by file locality to keep review coherent.

**Batch reconciliation:** these rows currently live in F14/F18/F19/F20/F29/F32/F33/F42/F45. Do not
re-file them. Claim the rows a wave needs; the batch labels stay as the historical record. Where a
wave takes only part of a batch, note the split in the PR body so the remainder is not assumed done.

---

## 5. What this plan deliberately does not do

- **Does not re-plan Phase 0.** B2 *is* the existing 15-task plan.
- **Does not re-file any registry row.** Waves reference; they do not duplicate.
- **Does not duplicate ROAD items.** ROAD-76…ROAD-95 remain the feature backlog; the wave items
  added alongside them are an index over that backlog plus the registry, not a second copy.
- **Does not schedule dates.** Waves are ordered, not calendared — the fleet's throughput sets the
  pace, and a date here would be fiction.
