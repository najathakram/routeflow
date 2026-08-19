# D1 — boxed-line payload fixes: the two critical silent overcharges

**Status:** IMPLEMENTED — pipeline (2 fix rounds) + independent 3-lens verification; final fixes: addProduct carries unitsPerBox, cancel-Undo gated on substitution, publish path sends pendingDeletes
**Scale:** major (api + web + mobile; money-critical — active silent overcharges)
**Source:** deep-dive findings B1/B2/B3 (memory `project_deep_dive_findings_2026-08-17`), all three re-verified against master `1415e7ef` on 2026-08-19.

## Context — what goes wrong today

**B1 (CRITICAL, mobile).** In the order editor (`edit-items.tsx`), adding a **fresh** case-packed product sets `{ ...base, qty: upb, boxes: 1, pieces: 0 }` **without `boxSplit: true`** (line ~506) — unlike its two sibling branches (piece-add ~505 and existing-line ~479) which set it. At save, the payload mapper emits `boxSplit: !!i.boxSplit` = false, so `buildOrderItemDiff`'s `boxFields` gate (`order-item-diff.ts:93`) strips boxes/pieces, and the payload carries only `{productId, qty: unitsPerBox}`. The server (new-item branch) takes qty verbatim and `computeLineSubtotal` — seeing no boxes/pieces — bills **box-price × piece-count**: a $24 case is billed as $288. The local preview reads `boxes/pieces` directly and shows the correct $24, so the operator cannot see it.

**B2 (CRITICAL, mobile + web).** Substituting a product on an order line emits only `{ id, substituteProductId, qty }` (`order-item-diff.ts:117-118`) — no boxes/pieces ever, even though the server explicitly supports a box split on substitution ("Honor it the same way as a fresh add", `orders.service.ts` substitute branch, which computes `qtyVal = boxes*upb + pieces` when present). Inheriting qty=24 onto a 12-pack substitute bills **24 × the case price instead of 2 ×**. Web's golden reference has the **same defect** (its substitute push omits boxes/pieces, with a comment documenting the omission) — this is a shared bug, fix both.

**B3 (HIGH, mobile + web + api).** A price override on a substituted line is silently discarded twice over: the client substitute branch never sends `unitPrice`, and the server substitute branch unconditionally does `const unitPrice = Number(product.pricePerUnit)` — it never reads `item.unitPrice`. The card shows the override; the saved line bills the substitute's list price. This also discards the customer's tier price on every substitution.

## House rules that bind this fix

- Money math through `pricing.ts` helpers only — `computeLineSubtotal` for any boxed line, never `qty * unitPrice`.
- Override convention (standing owner decision): an override is stored as the **net `unitPrice`** with `originalPrice` = the displaced price for strikethrough and `discount: 0` — never re-derive.
- **No Prisma migration.** No change to `pricing.ts` itself.
- Compatibility: the server already accepts boxes/pieces on substitution, and an old server simply ignores an incoming `unitPrice` — so clients and server can ship in ONE PR with no ordering hazard.
- Do NOT touch: `apps/web/e2e/06-critical-paths.spec.ts` or the e2e seed (two other sessions are working there right now), drafts, van sale, scanner files.

## Work packages

### WP1 — mobile payload correctness

**Files owned:** `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`, `apps/mobile/lib/order-item-diff.ts`, `apps/mobile/__tests__/order-item-diff.test.ts`

1. **B1 one-line fix:** in the fresh-add case branch (~506), add `boxSplit: true` so it matches its siblings:
   `: { ...d, [p.id]: { ...base, qty: upb, boxes: 1, pieces: 0, boxSplit: true } };`
2. **Belt for the whole class** in `order-item-diff.ts`: change the `boxFields` gate from trusting the separately-maintained boolean to reading the data — `const boxFields = line.boxes != null || line.pieces != null ? { boxes: line.boxes ?? 0, pieces: line.pieces ?? 0 } : {};` — so a future branch that forgets `boxSplit` cannot re-create B1. Read every producer of the catalog array first and confirm no line carries stale boxes/pieces while intending a plain qty (the editor's `setQty` path for non-boxed lines must not leave residue; verify, and if any path does, clear boxes/pieces there rather than weakening this gate).
3. **B2/B3 in the substitute branch (117-118):** emit `boxFields` (same computation as the UPDATE branch) and, when the line carries an operator override (`unitPrice` diverging from the line's `basePrice` by more than EPS, same test the new-line branch uses), emit `unitPrice` and `overrideReason` (when present):
   ```ts
   if (line.substituteProductId && line.substituteProductId !== orig.productId) {
     const overridden = Math.abs(line.unitPrice - line.basePrice) > EPS;
     out.push({
       id: line.lineId,
       substituteProductId: line.substituteProductId,
       qty: line.qty,
       ...boxFields,
       ...(overridden
         ? {
             unitPrice: line.unitPrice,
             ...(line.overrideReason ? { overrideReason: line.overrideReason } : {}),
           }
         : {}),
     });
     continue;
   }
   ```
   Check what `basePrice` holds for a substituted line in the editor (the substitute handler computes `tierPriceFor(p)` — confirm it stores that as the line's basePrice so "overridden" means diverging from the SUBSTITUTE's tier price, not the original product's).
4. Extend the spec: (a) fresh boxed add (boxes 1, pieces 0) emits boxes/pieces in the payload; (b) boxed substitution (2 cases of 12 = qty 24) emits `{boxes: 2, pieces: 0}`; (c) substitution with an override emits `unitPrice` + `overrideReason`; (d) substitution at the substitute's tier price emits NO unitPrice; (e) a plain qty line still emits no boxes/pieces (the gate change didn't leak).

### WP2 — server honors the substitute override

**Files owned:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`

In `updateOrderItems`'s substitution handling (the branch computing `qtyVal` from boxes/pieces and then `const unitPrice = Number(product.pricePerUnit)`):

1. Determine the role context of this branch first (the operator path vs the driver/customer always-replace branch — drivers must NOT gain price control, consistent with how the DRIVER edit path re-prices server-side).
2. For **staff** (OPERATOR/TENANT_ADMIN): when `item.unitPrice != null`, use it as the line's net `unitPrice`, with house override semantics — `priceType: DISCOUNTED` when below the substitute's list price, `MANUAL` when above (mirror the existing create/update branch conventions exactly — read them, do not invent), `originalPrice` = the substitute's list price, carry `overrideReason` when provided. When `item.unitPrice == null`, keep today's behavior (substitute's `pricePerUnit`).
3. For non-staff: ignore `item.unitPrice` entirely (keep `pricePerUnit`), mirroring the B13 posture that non-staff never set prices on this path.
4. The line's `subtotal` must be recomputed via `computeLineSubtotal` with the boxes/pieces (already the case for the split — verify the override flows into the same computation), and the existing post-mutation recompute (`recomputeLineCategoryTaxes`, totals fold) must run unchanged.
5. Spec: substitution with `{boxes: 2, pieces: 0, unitPrice: <override>}` from an operator bills 2 × override (through `computeLineSubtotal`), stores `originalPrice` = substitute list, `priceType` per convention; the same DTO from a driver bills at `pricePerUnit`; substitution without unitPrice unchanged (regression pin).

### WP3 — web mirrors the payload fix

**Files owned:** `apps/web/app/(dashboard)/orders/[id]/page.tsx`

The substitute payload push (~1557, documented by a comment near ~1005 explaining the omission): include boxes/pieces from the line's boxed state and `unitPrice`/`overrideReason` under the same "diverges from the substitute's tier/base price" rule the web edit flow uses elsewhere. Update the stale comment — it currently documents the bug as intended behavior. Match mobile's semantics exactly (WP1 item 3); the two clients must send the same shape.

## Acceptance criteria

- [ ] Adding a fresh case-packed product in mobile edit-items and saving bills 1 × case price (payload carries `boxes: 1, pieces: 0`).
- [ ] `order-item-diff`'s box gate keys on data presence, not the `boxSplit` flag, with no leakage on plain-qty lines (spec-pinned).
- [ ] A boxed substitution bills boxes × case price on both clients (spec-pinned mobile; web sends the identical shape).
- [ ] An operator's override on a substituted line is billed and stored with `originalPrice`/`priceType` per the house convention; a driver's is ignored.
- [ ] Substitution without an override behaves exactly as today (regression-pinned).
- [ ] No `pricing.ts` change, no migration, no touching the e2e critical-paths spec or seed.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/api --force
npx turbo run check-types lint test --filter=@routeflow/mobile --force
npx turbo run check-types lint --filter=@routeflow/web --force
```
