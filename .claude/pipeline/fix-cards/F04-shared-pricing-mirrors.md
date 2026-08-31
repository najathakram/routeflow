# F04 · Shared pricing mirrors

**Bug IDs (3):** B50, B109, B122

**Root cause:** Three defects in the money kernel itself — BOGO short-pick proration diverging from the server's paid-basis telescope, promo selection comparing savings on a different quantity basis than it bills ($53.95 verified overcharge), and roundMoney's EPSILON nudge being a no-op above $2.

**Ships as:** One PR.

**Files:** all three pricing.ts mirrors (apps/api/src/common, apps/web/lib, apps/mobile/lib) · apps/mobile/lib/short-pick.ts · pricing.spec.ts

**Together because:** The mirrors must move as one, and every later money batch reads them.

**Guardrails / shared infra:** Delivers G3 — a pricing-mirror parity spec, BEHAVIOURAL against expected values (not mirror-to-mirror diff, since B109/B122 were invisible precisely because all three mirrors agreed on the WRONG answer). Note there is a FOURTH pricing file, apps/api/src/utils/pricing.ts (the tier ladder: getTierPrice, TIER_FIELDS, cascadeTierPrices), and prorateLineSubtotal/effectiveQty exist ONLY on mobile (apps/mobile/lib/pricing.ts:200,214) — extract to all three/four and cover the tier ladder in the parity spec too.

**Dependencies / lane notes:** Must land before F05, F06 (semantic — both bill using the corrected pricing kernel).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F04.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B50  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B109 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B122 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B50 — Driver short-pick "amount due" omits the BOGO free-unit proration the server applies

**Area:** apps/mobile/lib/pricing.ts + short-pick.ts -&gt; driver payment screen

**Meant to do:** The driver's at-door amount due for a short-picked BUY_N_GET_M line should equal what the server actually invoices for the delivered quantity, so collected cash reconciles against the invoice.

**Actually does:** Mobile prorateLineSubtotal does storedSubtotal * deliveredQty / orderQty (linear). The server's buildInvoiceItemData prorates over the PAID (net-of-free-units) quantity with a floored cumulative telescope. Worked example at unitPrice $10, qty 6, freeUnits 1 (stored subtotal $50): deliver 5-of-6 -> mobile $41.67 vs server $50.00; deliver 3-of-6 -> mobile $25.00 vs server $30.00.

**The gap:** Client and server diverge on any short-picked promo line, and short-pick.ts's docstring claim of an "identical/server-exact formula" is false. The collected amount is then applied against the server's (different) total, so the difference is silently under-paid or dropped.

**Evidence:** apps/mobile/lib/pricing.ts:200-207 (prorateLineSubtotal); apps/mobile/lib/short-pick.ts:69-87 (docstring + reconciledTotal); apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx:111-118; apps/api/src/invoices/invoices.service.ts:827-897 (paid-basis telescope) reached via reconcileOrderDraftInvoice (:1367) <- recordDeliveryPaymentInTx (:4401) <- apps/api/src/routes/routes.service.ts:1774; apps/api/src/orders/orders.service.ts:1760-1801 (storedSubtotal bakes freeUnits in at creation).

**Suggested fix:** Either fetch a server-computed reconciled total before the driver charges (a preview endpoint), or port buildInvoiceItemData's paid-basis telescoping formula into prorateLineSubtotal/reconciledTotal so client and server agree to the cent.

### B109 — applyBestPromotion values price promos by whole boxes only, so BOGO can beat a cheaper promo — $53.95 verified overcharge

**Area:** Promotions · shared pricing (api/web/mobile)

**Meant to do:** When several promotions cover a line, the buyer is billed under whichever yields the largest total dollar saving for the line as entered, per the function's own contract (pricing.ts:397-404).

**Actually does:** Price-promo saving is (base−net)×qtyUnits (whole boxes only) while the net price later applies to boxes+pieces/upb; BOGO saving is exact. On 2 boxes+23 pcs @$120/24: BOGO wins (120 vs 117.60), bills $235.00 vs PERCENT's $181.05.

**The gap:** Savings comparison and actual billing use different quantity bases for price promos, biasing selection toward BUY_N_GET_M on mixed boxed lines.

**Evidence:** apps/api/src/common/pricing.ts:429 (BOGO saving exact) vs :434 (price-promo saving × qtyUnits), :108-114 (net price applied to prorated pieces), :397-404 (contract); qtyUnits = boxes at server call sites apps/api/src/orders/orders.service.ts:1715, 2805, 2970, 3091, 4396; recomputed by executing the shipped algorithm: savings 117.60 vs 120.00, bills 235.00 vs 181.05, overcharge 53.95, true PERCENT saving 173.95.

**Suggested fix:** Compute price-promo saving on the full box-equivalent quantity — saving = roundMoney((base−net)×(qtyUnits + qtyPiecesLoose/upb)) — or equivalently compare candidate line subtotals via computeLineSubtotal. Change all three pricing.ts mirrors together.

### B122 — roundMoney's EPSILON nudge is ineffective at ≥$2 — ~4.6% of half-cent values round down against the documented policy

**Area:** Money rounding · shared pricing (api/web/mobile)

**Meant to do:** Every monetary half-cent rounds away from zero at the cent, per the function's stated contract, so an auditor's decimal recomputation (e.g. 7.5% tax on $29.00 → $2.18) matches the system.

**Actually does:** Number.EPSILON is at most half a ULP for |n|≥2, so the nudge does nothing there; 4,573 of 100,000 half-cent literals in [0.005,1000) round down (2.135→2.13, 2.175→2.17). Tax on $29.00 yields $2.17.

**The gap:** Effective rounding above $2 is representation-dependent, not the documented half-away-from-zero; the spec's pins (4.005, 2.675) pass coincidentally.

**Evidence:** apps/api/src/common/pricing.ts:23-34 (contract + implementation); identical bytes verified in apps/web/lib/pricing.ts:104 and apps/mobile/lib/pricing.ts:105; spec pins apps/api/src/common/pricing.spec.ts:37-42; brute-force re-executed: exactly 4,573/100,000 round down, first failures 2.135/2.175/2.385/2.425/4.015; end-to-end reproduced: 0.075×29.00→2.17, 0.075×27.40→2.05, 15% of 9.50→8.07, perUnitPrice(4.27,2)→2.13.

**Suggested fix:** Round in integer-cent space, e.g. scale via a decimal-string path (Number(n.toFixed(3)) then round the cent digit) or Math.round(Math.abs(n)*100 + 0.5-epsilon-free comparison on the third decimal); update the comment and add spec pins for 2.135/2.175/4.015. Change all three mirrors together.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
