# Discovery — why the Lite ($99/mo, invite-only) plan

**Status:** `DRAFT` · **Stage:** S1 — Discovery (why) · **Author:** Fable 5.1 · **Date:** 2026-09-15
**Lives at:** `.claude/pipeline/2026-09-15-lite-L2-plan/discovery.md` (worktree `rf-lite-L2` @ origin/master bc24582d)
**Next:** [spec.md](./spec.md). Facts: `CP §n` = [context-pack.md](./context-pack.md); `LAUNCH` = the owner's launch print.

> Lane L2 of the Lite launch. L1 (flavor at entry + printing) shipped and merged. This lane is
> heavily precedent-driven — every mechanism has a sibling in the repo — so this file is short.

---

## 1. The problem, in the requester's own words

> "a basic customer starts ASAP on orders/invoices + payments + inventory only, on an iPad/Android
> tablet with an attached printer … Lite = $99/mo, unadvertised, offered only to known customers,
> upsold later." — owner, 2026-09-15 ~02:1xZ (LAUNCH header)

**Restated:** HQ needs a fifth catalog plan that is (a) invisible to everyone HQ did not invite,
(b) limited to the five core surfaces, (c) billed through Stripe like every other plan, and
(d) invisible in effect to every tenant that already exists. **Source:** owner ask → lead
routeflow-c4 → Fable rulings R1–R7 (LAUNCH); Q1–Q4 defaults confirmed by the lead 2026-09-15.

## 2. Who has this problem

| Role                                | Frequency                                      | Cost today                                                                             | Evidence                                             |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Owner / HQ (SUPER_ADMIN)            | one customer now; more "known customers" later | cannot represent a reduced plan — every new tenant gets STARTER's full surface         | LAUNCH header; `PLAN_KEYS` is a closed 4-set (CP §1) |
| The Lite customer (tablet operator) | daily, all day                                 | a full dashboard they did not buy: dispatch, AP, analytics, portal — noise on a tablet | owner's description of the use                       |
| Every existing tenant               | n/a — must feel nothing                        | the risk, not a cost: a gating change that leaks to them                               | R7; CP §5's global-boolean gap                       |

## 3. What they do instead today

- **Workaround:** create the customer on STARTER (also $99/mo in v11 — `publish-plan-catalog-v11.ts:157`, A3) and tell them to ignore what they don't use.
- **Why it fails:** no exclusivity (STARTER is on the public pricing page), no upsell ladder, and the customer sees and can trigger every feature — support load and confusion on a tablet.
- **Cost:** HQ's plan structure is unrepresentable; the "upsell later" promise has no lower rung.

## 4. Why now

A specific known customer starting ASAP (LAUNCH). L1 already gave them flavor-at-entry and printing; L2 gives them the plan they were sold. **Deadline:** none dated; "ASAP" — the merge window follows #743 (lead's sequencing).

## 5. If we ship nothing

The customer starts on STARTER at the same price with more features. Revenue today is identical; what is lost is the invite-only tier itself, the upsell ladder, and the owner's stated packaging. Not catastrophic — but the ask is small, additive, and precedent-driven, so shrinking it further gains little. **Verdict: ship.**

## 6. Success signal

| Signal                                                                                                                                                               | Baseline                                                                                              | Target                                                  | Measured where                                                                   | When                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- |
| The first admin-created LITE tenant is `ACTIVE` with a Stripe subscription at $99/mo, **and** zero PLAN_GATE / `addon gate denied` log lines for any non-LITE tenant | 0 LITE tenants; today's deny-log rate for existing tenants = 0 for the flags in scope (they are dark) | 1 ACTIVE LITE tenant; existing-tenant deny rate stays 0 | Railway api logs; `audit-tenant-entitlements.mjs`; `post-deploy-check` on `test` | 7 days after deploy |

## 7. Everyone else affected

| Party             | How                                                                                                                          | Needs                                | Consulted       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------- |
| Support / HQ      | new deploy-order step (publish v12 before the first LITE tenant); "Not on your plan" questions                               | the PR-body runbook line (spec R8.4) | via lead        |
| Finance / billing | a fifth Stripe line-item name ("RouteFlow Lite — monthly"); no Stripe Price object exists for any plan (inline `price_data`) | nothing manual                       | n/a             |
| Existing tenants  | must see nothing                                                                                                             | the R7.1 before/after matrix         | by construction |
| Marketing site    | `GET /billing/plans` must not gain a card                                                                                    | R2.2                                 | n/a             |
| Mobile            | first entitlement read on mobile; a new small locked screen                                                                  | ux-spec                              | n/a             |

## 8. Root-cause check

- **Symptom or cause:** cause — the catalog cannot express an invite-only, reduced, born-enforced plan.
- **Solving the problem or the picked solution:** the picked solution (a catalog plan) _is_ the general solution; the alternative — a per-tenant "feature mask" outside the catalog — would be a second entitlement system (forbidden by the money/gating discipline).
- **Prior art:** `SELF_SERVICE_ADDON_SKUS` hides admin-only SKUs (CP §3); `DARK_PLAN_FLAGS` ships gates dark (CP §5); `addons.ts` hides nav fail-open (CP §7); `LockedPage` exists (CP §7); v9 added MSRP as a new PlanVersion without touching pinned tenants (CP §3).

## 9. Riskiest assumption and the cheapest kill

| #   | Assumption                                                                                                                | If wrong                           | Cheapest kill                                                                                          | Cost       | Result                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | "Dark for existing plans, enforced for LITE" can be expressed without touching any existing tenant's data or decision     | R3/R7 conflict; the lane stalls    | read `plan-flag.guard.ts` + `entitlements.service.ts compute()` and write the guard matrix (spec R7.1) | 20 min     | **held** — spec R3a (guard reads the resolved plan; courtesy skipped for a named set; resolution failure keeps the courtesy)                                     |
| A2  | A LITE tenant can _pay_ for LITE through an existing self-serve path even though LITE is excluded from the public catalog | Lite tenants stuck READ_ONLY       | grep web for a checkout hook; grep API for `POST /billing/checkout`                                    | 5 min      | **held** — `POST /billing/checkout` (`billing.controller.ts:47`) prices from the tenant's current plan, never a client key; web needs one hook + CTA (spec R2.5) |
| A3  | STARTER is also $99/mo, so Lite's price equals Starter's                                                                  | none functional — a sales decision | owner confirms (Q3 below)                                                                              | 1 question | pending, non-blocking                                                                                                                                            |

## 10. Non-goals

- Manual invoicing (Q1 default = Stripe; one constant flips the CTA off).
- Any self-serve path _to_ Lite — subscribe/upgrade/downgrade to LITE are refused (R2).
- Gating the buyer-_facing_ portal controllers (seller-context guard) — follow-up F-1; no residual at launch.
- Flipping any dark flag to enforced for existing plans — the owner's blast-radius decision, F-2.
- A plan-flag registry (the owner's precondition for removing `DARK_PLAN_FLAGS`) — F-3. Note: this lane adds six keys to a set whose comment says "REMOVE by 2026-10-01"; that date is now unreachable without F-3 and the owner should hear it.
- Mobile billing UI; STARTER price/feature changes; printing/flavor (L1, shipped).

## 11. Open questions

| #   | Question                                                  | Unblocks             | Blocking S2? | Answer / assumption                                                                               |
| --- | --------------------------------------------------------- | -------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Q1  | Billing path                                              | R2.5                 | no           | **Stripe subscription via the existing checkout** (lead-confirmed default)                        |
| Q2  | Returns / credit notes on Lite                            | R3b.6                | no           | **OFF** (lead-confirmed default)                                                                  |
| Q3  | Trial on Lite                                             | R2.7                 | no           | **none — billed from day one** (lead-confirmed default)                                           |
| Q4  | Display name                                              | R2.8                 | no           | **"Lite"** (lead-confirmed default)                                                               |
| Q5  | STARTER is also $99/mo in v11 — is price parity intended? | nothing in this lane | no           | assumed intended (invite-only is about exclusivity, not price); a later price change is a v13 row |

## 12. Assumptions (unverified)

| #   | Claim (§)                                                                                                      | Basis                                                                                             | Confirm by                                                                       | Breaks                                                    | Status                         |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| A1  | §9: R3a is implementable with zero existing-tenant change                                                      | read `plan-flag.guard.ts:51-94`, `addon.guard.ts:53-76`, `entitlements.service.ts:85-100,134-230` | spec R7.1 matrix + R3a.4                                                         | R3, R7                                                    | held (design), proven at S4    |
| A2  | §9: `POST /billing/checkout` activates a READ_ONLY tenant on completion                                        | inferred                                                                                          | read the checkout-completed webhook in `apps/api/src/billing/billing.service.ts` | R2.5/R2.7 (fallback: raise `INVITE_ONLY_PLAN_TRIAL_DAYS`) | unverified                     |
| A3  | §3: STARTER `monthlyPrice: 99` in v11                                                                          | read `apps/api/prisma/publish-plan-catalog-v11.ts:157`                                            | owner answer to Q5                                                               | nothing functional                                        | confirmed reading; intent open |
| A4  | §2: the Lite customer runs the web dashboard or the Expo app as an OPERATOR on a tablet (not the buyer portal) | owner's description                                                                               | owner                                                                            | ux-spec's screen list                                     | unverified, low risk           |

---

## STOP GATE — S1 → S2

- [x] problem in their words + ours · [x] user named · [x] workaround + why it fails · [x] one signal with baseline · [x] ship-nothing answered · [x] root-cause check · [x] riskiest assumption + cheap kill · [x] non-goals · [x] blocking questions answered · [x] assumptions block

| Stop condition                     | Evaluated? | Answer                                                                 | Evidence   | Verdict |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------- | ---------- | ------- |
| Shipping nothing is materially bad | yes        | not catastrophic; the ask is small and additive — ship                 | §5         | pass    |
| Cause, not symptom                 | yes        | catalog cannot express the plan                                        | §8         | pass    |
| User, workaround, signal stated    | yes        | HQ + tablet operator; STARTER workaround; ACTIVE LITE tenant + 0 leaks | §2, §3, §6 | pass    |
| Blocking questions answered        | yes        | Q1–Q4 lead-confirmed; Q5 non-blocking                                  | §11        | pass    |

- **Gate outcome:** PASS — S2 written. **Assumptions carried into S2:** A2, A3.
- **Approved by:** Fable 5.1 · 2026-09-15
