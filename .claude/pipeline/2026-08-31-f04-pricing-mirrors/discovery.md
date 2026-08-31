# F04 · Shared pricing mirrors — discovery

**Status: EXECUTED** · scale **MAJOR** (money kernel; every later money batch reads it) · base
`master 77a8c058` · Batch F04, board #517 · IDs B50, B109, B122 · **money batch ⇒ the standing
Fable adversarial pass over the final diff applies at close-out (house rule, caught a CRITICAL
on #421 after clean lenses).**

All three CONFIRMED on base by direct read:

- **B122** — `common/pricing.ts:28-34`: `Math.round((Math.abs(n) + Number.EPSILON) * 100)`;
  EPSILON ≤ half-ULP for |n|≥2, so the nudge is a no-op there and ~4.6% of half-cent values
  round down against the documented half-away-from-zero contract. Register's brute-force: first
  failures 2.135 / 2.175 / 2.385 / 2.425 / 4.015; end-to-end 0.075×29.00→2.17 (should be 2.18).
- **B109** — `common/pricing.ts` `applyBestPromotion` (~L425-436): BOGO saving is exact
  (`freeUnits * base`) while price-promo saving is `(base - net) * qtyUnits` — **whole boxes
  only** — although billing later applies the net to boxes + pieces/upb. Register's worked case:
  2 boxes + 23 pcs @ $120/24 ⇒ BOGO "wins" (saving 120.00 vs 117.60) and bills $235.00 where
  PERCENT bills $181.05 — **$53.95 overcharge**; PERCENT's true saving 173.95.
- **B50** — `apps/mobile/lib/pricing.ts:200-207`: `prorateLineSubtotal` is linear
  (`storedSubtotal × delivered / ordered`) while the server's `buildInvoiceItemData`
  (`invoices.service.ts:827-897`, reached via `reconcileOrderDraftInvoice` ←
  `recordDeliveryPaymentInTx` ← routes) prorates over the PAID (net-of-free) quantity with a
  floored cumulative telescope. Worked: unitPrice $10, qty 6, freeUnits 1 (stored $50): deliver
  5/6 → mobile $41.67 vs server **$50.00**; 3/6 → $25.00 vs **$30.00**. `short-pick.ts:69-87`'s
  "server-exact formula" docstring is false today.

Structural findings that scope the fix (from the plan's G3 section, re-confirmed):

- There is a **fourth pricing file**: `apps/api/src/utils/pricing.ts` — the tier ladder
  (`getTierPrice`, `TIER_FIELDS`, `cascadeTierPrices`), untyped `product: any`, with typed
  client twins. The parity spec must cover it.
- `prorateLineSubtotal` / `effectiveQty` exist **only on mobile** — the API and web mirrors have
  no equivalent, which is why the divergence could exist at all. The corrected telescope
  implementation goes into **all three mirrors** (exported; wiring web callers is out of scope).
- **Lane fence:** F04 must NOT edit `apps/api/src/invoices/invoices.service.ts` (F03's lane
  head owns it). The server telescope is the REFERENCE for expected values; the mirrors are
  brought to it, never it to the mirrors, in this batch.

Register evidence classification: B50 CONFIRMED · B109 CONFIRMED · B122 CONFIRMED (all
`master@77a8c058`; citation drift zero — line numbers matched within ±5).
