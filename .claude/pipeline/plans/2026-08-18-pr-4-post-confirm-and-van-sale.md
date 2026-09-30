# PR-4 — post-confirm flow + van sale

**Status:** IMPLEMENTED — shipped 2026-08-18/19; see the PR for the verified final shape
**Scale:** major (mobile-only, but money-critical: a new save path that creates orders and moves stock)
**Sources of truth:** `.claude/pipeline/decisions/2026-08-18-batch-architecture.md` **§A2** (the gate contract — binding, quoted below) and **§PR-4**. Also `docs/plans/mobile-ux-batch-2026-08-17.md` §PR-4. If anything here disagrees with the decisions doc, the decisions doc wins.

**Dependency satisfied:** PR-B (#356) is merged AND deployed, so `orders.create` now taxes with a correctly denominated fraction. This PR must not merge before that — it has.

## Context

Two owner-reported problems:

1. **Confirming an order dumps the operator on a locked invoice.** `orders/[id].tsx` auto-calls `openInvoiceForOrder()` on CONFIRMED success (~line 339), pushing to an invoice that is a pending mirror and therefore cannot be edited or sent. The operator has to navigate back to do anything.
2. **A van sale takes too many steps.** Selling from the van is create → confirm → deliver → invoice → send. The server already collapses this: `POST /orders/sell` with `deliveredNow` creates the order, marks it delivered, moves stock, and issues + sends the invoice. Web uses it (`useCreateSale`); mobile never has.

**The danger** is that the two save paths are not equivalent. The plain `POST /invoices` path creates no order and moves no stock; the sale path does both. The from-order invoice hardcodes `discount: 0` (`invoices.service.ts:809`), so an invoice-level discount silently vanishes. Mobile invoice lines are **untaxed by default** (`invoice-totals.ts` serializes `taxRate: line.taxable ? rate : 0`, and lines are created with no `taxable`), while `orders.create` taxes the whole subtotal. So sale mode may only be used when it provably produces the same total.

## Non-goals / do not touch

- No API change of any kind. No Prisma migration. `pricing.ts` untouched.
- Do NOT send `send` on the wire — the server ignores `dto.send` entirely (`orders.service.ts:1681-1685`). It is a dead field.
- Do NOT send `discountAmount` (gate rule 2 guarantees it is 0).
- Do NOT gate sale mode on "tax rate is non-zero" — that workaround was explicitly rejected; the equality assertion replaces it.
- Do not touch drafts (PR-3), the scan ladder, driver flows, or the buyer portal.

## Work packages

### WP1 — the gate + the predictor (pure) — `apps/mobile/lib/sale-mode.ts`

**Files owned:** `apps/mobile/lib/sale-mode.ts` (new), `apps/mobile/__tests__/sale-mode.test.ts` (new)

Pure module (no api-client/react-query imports; must run in the node Jest env).

```ts
export interface SaleGateInput {
  lines: InvoiceTotalsLine[]; // the EXACT array fed to computeInvoiceTotals
  hasUnlistedInvalid: boolean; // any unlisted line with empty name or price <= 0
  invDiscount: number; // invoice-level discount (0 if unset)
  shippingFee: number;
  isTaxExempt: boolean;
  taxRateFraction: number; // tenant percent / 100
  touched: { dueDate: boolean; terms: boolean; reference: boolean; subject: boolean };
  sendNowOn: boolean;
  deliveredNow: boolean;
  hasSeparateInvoiceCategoryLine: boolean;
}
export type SaleGateResult = { eligible: true } | { eligible: false; reasons: string[] };
export function saleModeGate(input: SaleGateInput): SaleGateResult;
```

Rules **in this order**; every hit appends its operator-facing reason and the result is ineligible:

1. Any line carries a per-line discount ⇒ `"a line discount is set"`. (`OrderItemDto` has no discount field. Do NOT fold it into a `unitPrice` override — that changes `originalPrice` semantics and boxed proration.)
2. `invDiscount > 0` ⇒ `"the invoice discount is set"`. (Dropped by `invoices.service.ts:809`.)
3. Tax mix: eligible only when `taxRateFraction === 0` OR **every** line (catalog and unlisted) has `taxable === true` ⇒ else `"some lines aren't taxed"`.
4. Any of `touched.dueDate|terms|reference|subject` ⇒ `"due date / terms / reference are set"`. Dirty means the user edited it, not a value comparison.
5. `deliveredNow === false && sendNowOn` ⇒ `"sending now without delivery"`.
6. `hasSeparateInvoiceCategoryLine` ⇒ `"a regulated item bills on its own invoice"`.
7. **The assertion, which is the real contract:** `Math.round(predictSaleInvoiceTotals(...).total * 100) === Math.round(computeInvoiceTotals(sameInputs).total * 100)`; if not, ineligible with `"the totals would not match"`. Zero tolerance — both sides are `roundMoney` outputs.

```ts
/** Mirror of orders.create → createInvoiceFromOrder for a FULL fresh sale:
 *  subtotal = roundMoney(Σ computeLineSubtotal(line))        [no per-line discounts on this path]
 *  tax      = isTaxExempt ? 0 : roundMoney(subtotal × taxRateFraction)
 *  total    = roundMoney(subtotal + tax + shippingFee)       [discount is hardcoded 0 server-side]
 */
export function predictSaleInvoiceTotals(input): {
  subtotal: number;
  taxTotal: number;
  total: number;
};
```

Both functions must use `computeLineSubtotal`/`roundMoney` from `lib/pricing` — never `qty * unitPrice`.

**Spec must cover:** (a) all-untaxed lines + non-zero tenant rate ⇒ ineligible (this is the DEFAULT mobile invoice — the case that motivated the gate); (b) mixed taxable ⇒ ineligible; (c) all taxable at the tenant rate ⇒ eligible; (d) `taxRateFraction === 0` with untaxed lines ⇒ eligible; (e) invoice discount > 0 ⇒ ineligible even when totals happen to match; (f) each touched header field ⇒ ineligible; (g) `deliveredNow:false + sendNowOn` ⇒ ineligible; (h) a boxed line (unitsPerBox > 1 with boxes/pieces) is predicted identically by both paths ⇒ eligible; (i) multiple simultaneous violations ⇒ all reasons present.

### WP2 — `useCreateSale` for mobile — `apps/mobile/lib/api/orders.ts`

**Files owned:** `apps/mobile/lib/api/orders.ts`

Add `useCreateSale()` mirroring web's (`apps/web/lib/api/orders.ts` ~298): `POST /orders/sell`, invalidating the same caches `useCreateOrder` does **plus** `["invoices"]` (the sale issues an invoice) and `["products"]`/inventory keys if `useCreateOrder` does. Export a `CreateSaleDto` type carrying exactly: `customerId`, `items` (catalog `{productId, qty, boxes?, pieces?, unitPrice?, notes?}` **and** unlisted `{name, qty, unitPrice, notes?}`), `deliveredNow: boolean`, `notes?`, `shippingFee?`, `orderDate?`. **No `send`, no `discountAmount`** — document why in a comment.

### WP3 — post-confirm flow — `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`

**Files owned:** `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`

- Remove **only** the auto-`openInvoiceForOrder()` on the CONFIRMED success branch (~line 339). Confirm success = toast + stay on the order. The explicit "View invoice" tile stays exactly as it is.
- In the CONFIRMED action grid: promote "Quick deliver" to **primary** and relabel it **"Deliver & send invoice"** (its existing DELIVERED branch already chains `openSendForOrder()` → `SendInvoiceSheet`, so the two-tap flow already works once relabelled). "Send for delivery" becomes secondary.
- Verify the Edit-items tile still renders on DELIVERED (the API allows item edits at any live status and re-syncs invoices in place). Do not change its gating; just confirm and note it.
- Do NOT touch the ReasonSheet/demotion wiring from PR-1.

### WP4 — van-sale mode in the invoice builder — `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`

**Files owned:** `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx`

- In the review sheet add a **"Delivered today?" Yes/No segmented control, default YES**.
- Compute `saleModeGate(...)` from the builder's current state, feeding it the **same** `lines` array already passed to `computeInvoiceTotals` (this is what makes the assertion meaningful). Load `useTrackedCategories({ active: true })` to derive `hasSeparateInvoiceCategoryLine`.
- Eligible + Delivered-today YES ⇒ submit through `useCreateSale` with `deliveredNow: true`; eligible + NO ⇒ `useCreateSale` with `deliveredNow: false`; ineligible ⇒ the existing `POST /invoices` path, with the Delivered-today control **disabled** and the reason shown.
- `orderDate` is sent only when the builder's issue date is not today.
- **Disclosure copy (use verbatim):**
  - YES: `"Records the sale now: the order is marked delivered, stock is deducted, and the invoice is issued and sent. Available customer credit is applied automatically."` — and **hide the Send toggle in this mode** (sending is implied and not optional).
  - NO (still eligible): `"Creates a pending order with a draft invoice. Stock is deducted now; the invoice unlocks for sending once the order is delivered."`
  - Fallback: `"Saving as a regular invoice (no delivery tracking) — <reason>. Your total stays $X exactly as shown."`
- On success, navigate to the created invoice as the current save path does (the sale response carries the order; resolve its invoice the same way the existing flow does, or fall back to the invoices list with a toast — do not invent a new endpoint).

## Acceptance criteria

- [ ] `saleModeGate` returns ineligible for an all-untaxed invoice when the tenant rate is non-zero (spec-pinned) — the default mobile invoice never silently gains tax.
- [ ] The final equality assertion is integer-cents with zero tolerance and is evaluated last, so it catches divergences the enumerated rules miss.
- [ ] Neither `send` nor `discountAmount` appears anywhere in the sale DTO or on the wire.
- [ ] Unlisted lines are included in the sale items (not filtered out).
- [ ] Confirming an order no longer navigates away; "Deliver & send invoice" is the primary CONFIRMED action.
- [ ] The Send toggle is hidden when Delivered-today is YES; the Delivered-today control is disabled with the reason when the gate is ineligible.
- [ ] No file under `apps/api`, `apps/web`, `prisma/`, or any `pricing.ts` is modified.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/mobile --force
npm run verify
```
