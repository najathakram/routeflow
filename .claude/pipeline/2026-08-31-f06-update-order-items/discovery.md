# Discovery — why F06: updateOrderItems authorization + line build

**Status:** `APPROVED`
**Stage:** S1 — Discovery (why) · **Author:** Fable 5 · **Date:** 2026-08-31
**Lives at:** `.claude/pipeline/2026-08-31-f06-update-order-items/discovery.md`
**Next:** [spec.md](./spec.md)

> This file is the only context downstream agents receive about *why* this work exists.

---

## 1. The problem, in the requester's own words

> "One method missing the guards its siblings have. A buyer can price their own unlisted line
> (B51) and edit a delivered order (B63); a box-count and a piece-count are summed and billed
> as boxes (B47, ~4.7x overcharge); freeUnits is dropped on staff add (B60); urgent/date/notes
> vanish on merge (B78)." — fix card `.claude/pipeline/fix-cards/F06-update-order-items-authorization-line-build.md`,
> from the owner-approved bug-register burn-down campaign (register articles B47/B51/B60/B62/B63/B78).

**Restated:** `OrdersService.updateOrderItems` (apps/api/src/orders/orders.service.ts:2735-3856,
the largest method in the API) and its buyer-portal caller `BuyerController.createOrder`
(apps/api/src/buyer/buyer.controller.ts:517-561) lack authorization and line-construction
guards that `create()`, `changeStatus()` and the staff POST /orders merge already have. Six
register bugs share that root cause; they ship as one PR because they edit the same method or
its immediate caller.

**Source:** Bug-register campaign, batch F06 (board issue #519, epic #510). Owner explicitly
resumed the paused campaign and assigned this batch on 2026-08-31.

## 2. Who has this problem

| Role | How often | What it costs today | How we know |
|---|---|---|---|
| Buyer (portal customer) adding to an existing order of a boxed product | any merge onto a box-unaware line | ~4.7x overcharge (box price x summed mixed-unit qty) — B47, Critical | code path verified on master 26037bd4; register evidence re-anchored 2026-08-31 |
| Seller (tenant) of any buyer with API access | standing exposure | buyer can write an arbitrary-priced unlisted line onto their own order (B51, Critical); buyer can rewrite a DELIVERED order's lines, wiping delivery records and rebuilding paid invoices (B63) | code read: no role/status guard in the CUSTOMER branch; contrast create() :1714-1716 and changeStatus :2347-2358 |
| Operator editing an order with buyer-earned BUY_N_GET_M lines | every staff replace-all edit of such an order | promoFreeUnits snapshot destroyed → customer billed full price for earned free units (B60, reframed — see §8) | code read: replace-all block :3106-3237 writes no promoFreeUnits; qty-edit branch :3529-3675 has the fix pattern |
| Operator adding/substituting lines in the web order editor | every DRAFT auto-edit landing before the customer fetch resolves | line priced at list instead of contracted tier; substitute path SENDS the wrong price (B62) | web page read: tier defaults `?? 1` at page.tsx:1551; substitute :1282-1314 always sends unitPrice |
| Buyer whose cart merges into an active order | every merge | urgent flag, requested delivery date and notes silently dropped (B78) | buyer.controller.ts:546-550 forwards `{items}` only vs :565-577 fresh-create forwards all three |

## 3. What they do instead today

- **Workaround:** support tickets + manual invoice corrections after the fact; operators re-key
  urgent/date info from chat; nobody detects B51/B63-class tampering at all (no alert exists).
- **Why it fails:** overcharges reach issued invoices (money already billed); tampering leaves
  no flag; corrections are manual and error-prone.

## 4. Why now

Campaign lane order: F06 is first in the orders lane; F07 → F11 → F22+F24 → F16 are
positionally locked behind it (same file region). F04 (pricing-mirror kernel), its semantic
dependency, is live (#554). Two of six bugs are Critical with a fraud-shaped exposure.

## 5. If we ship nothing

Buyers of boxed products keep getting overcharged ~4.7x on merge; any buyer with API access
retains a self-pricing primitive and delivered-order rewrite; operators keep silently
destroying earned promo discounts. Four batches stay blocked behind this one.

## 6. Success signal — one, observable

| Signal | Today's baseline | Target | Where measured | When |
|---|---|---|---|---|
| `node scripts/campaign-check.mjs --batch F06` discharges all six rows (5x T1 REG-jest proven, B62 T2 via the deploy-triggered e2e run) | 6 rows `queued`, 0 proofs | 6 discharged | `.claude/campaign/status/F06.jsonl` + `.campaign/runs/*` | at merge (T1) and first post-deploy e2e run (T2) |

## 7. Everyone else affected that nobody asked

| Party | How this touches them | What they need |
|---|---|---|
| Drivers | share the CUSTOMER replace branch for non-diff edits and legitimately edit during delivery | B63's gate must be role-scoped to CUSTOMER — driver behavior byte-identical |
| F07 (next batch in lane) | owns apps/api/src/invoices/invoices.service.ts | F06 must not write that file; invoice-side findings go into F07's fix card as a lane addendum |
| Existing buyer clients (web + mobile portal) | send only `{productId, qty}` line items on edit | server-side preservation of unlisted lines must not require client changes (it doesn't — verified apps/web/lib/api/buyer.ts:458-475, apps/mobile/lib/api/buyer.ts:849-863) |
| Historical data (D4 repair duty) | rows already damaged by B47/B60-class writes | read-only candidate report post-deploy; repair flight only with evidence, backup first |

## 8. Root-cause check — is this a symptom?

- **Root cause**, not a symptom: sibling methods gained guards (create's unlisted-line
  rejection, changeStatus's CUSTOMER status gate, F30's denomination-aware staff merge,
  qty-edit's BOGO rescale) that were never mirrored into updateOrderItems / the buyer merge.
- **Register premise correction (B60):** the register claims staff adds store `priceType PROMO`
  while billing full price. FALSE on master: `loadActivePromotions` returns `[]` for every
  staff role (P5-04 invariant, orders.service.ts:92-98), so `resolveBuyerLinePrice` never
  returns PROMO on the staff add paths — the card's mechanical fix would be inert. The REAL
  defect in the cited region: the staff **replace-all** block recreates every line and
  destroys buyer-earned `promoFreeUnits` (no snapshot written, subtotal without freeUnits) —
  the same class the qty-edit branch fixed. F06 fixes that, keeps the card's plumbing as
  future-proofing, and corrects the register article at chip time.
- **Prior art:** F30's `foldMergeItems` (apps/api/src/orders/orders.controller.ts:113-250) is
  the exemplar for B47; `create()` :1714-1716 for B51; `changeStatus` :2347-2358 for B63;
  qty-edit branch :3529-3675 for B60.

## 9. Riskiest assumptions and status

| # | Assumption | If wrong | Check | Status |
|---|---|---|---|---|
| A1 | B60 reframe: staff promos are `[]`, real bug is replace-all snapshot destruction | wrong fix shipped, register chip dishonest | read orders.service.ts:92-98, :2844-2857, :3106-3237 | **confirmed 2026-08-31** (source read) |
| A2 | Buyer web+mobile edit clients send only `{productId, qty}` — ignoring client unlisted input breaks nobody | buyer-visible regression | read apps/web/lib/api/buyer.ts:458-475, apps/mobile/lib/api/buyer.ts:849-863 | **confirmed 2026-08-31** (source read) |
| A3 | No legitimate flow needs a CUSTOMER to author/reprice/drop unlisted lines | a buyer flow breaks | create() already forbids (:1714-1716); no buyer UI offers unlisted entry | confirmed by code + UI inventory |
| A4 | E2E spec/project number for this batch is **24** (owner instruction; 23 presumed reserved for a parallel lane; highest on master is 22) | numbering collision | owner said "any e2e spec is project 24" in the batch assignment | taken as directive |
| A5 | `deliveredQty`/`invoicedQty` FKs and delivery mutations survive because B51 preserves unlisted rows in place (never delete+recreate) | delivery record loss on unlisted lines | prisma schema OrderItem relations; preserved-row design avoids the question | design-time; verified by REG-B51 test asserting row id stability |

## 10. Non-goals — the scope fence

- **No staff-promotion widening** — `loadActivePromotions`'s staff-empty invariant stands;
  operator adds do not START earning BOGO (only stop destroying earned snapshots).
- **No product lookup inside `foldMergeItems`** — two box-UNAWARE contributions remain
  unit-ambiguous exactly as today (accepted residual, recorded in the fix card).
- **No change-request flow changes** — B63 points buyers at the existing flow; its UX is untouched.
- **No writes to `apps/api/src/invoices/invoices.service.ts`** — F07 owns it.
- **No UpdateOrderItemsDto extension with urgent/requestedDeliveryDate** — merge-branch-only
  need, solved in the buyer controller + a scoped service helper.
- **No web unit-test runner** (campaign decision D1) — B62 is proven post-deploy via e2e.

## 11. Open questions for the requester

None blocking. A4 (spec number 24) taken as an explicit instruction.

## 12. Assumptions (unverified) — MANDATORY

| # | Claim | Basis | What would confirm | What breaks if wrong | Status |
|---|---|---|---|---|---|
| A4 | §9: spec/project 24 is this batch's e2e slot | owner instruction in the batch assignment | none needed — directive | harmless numbering gap if 23 never lands | taken as directive |
| A6 | §2: the ~4.7x figure (unitsPerBox=12 example) | register worked example | REG-B47 test recomputes by hand: 2 boxes + 1 box at box price 10, upb 12 → correct 30.00 vs today's 140.00 | only the headline multiplier, not the fix | worked example, verified in test oracle |
| A7 | §6: `.campaign/runs/api.json` is produced by the repo's documented campaign flow before campaign-check reads it | F02/F04/F30 discharged T1 rows this way | `scripts/campaign-check.mjs` (reads `.campaign/runs/api.json`); reproduce the producing command at close-out | ledger flip blocked until produced | unverified — resolve at close-out |

---

## STOP GATE — S1 → S2 · **PASS**

| Stop condition | Evaluated? | Answer | Evidence | Verdict |
|---|---|---|---|---|
| Shipping nothing is materially bad | yes | Critical overcharge + fraud primitive on live tenants | §5 | pass |
| The ask is a cause, not a symptom | yes | root cause = missing sibling guards; B60 premise corrected | §8 | pass |
| User, workaround and success signal stated | yes | §2, §3, §6 | §2/§3/§6 | pass |
| Every blocking open question answered | yes | none blocking | §11 | pass |

**Gate outcome:** PASS — S2 may start. **Assumptions carried into S2:** A4 (directive), A5, A7.
**Approved by:** session (owner-delegated per campaign decision: Fable review substitutes) · 2026-08-31
