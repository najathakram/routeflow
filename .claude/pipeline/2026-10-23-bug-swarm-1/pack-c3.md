# pack-c3 (mobile) — master b430eed74. Mobile Jest = pure-logic `apps/mobile/__tests__/*.test.ts` (no RN render); pins read source via fs `readFileSync` (see invoice-line-count.test.ts) or test `lib/*.ts` helpers. Extract any logic to `apps/mobile/lib/*.ts` to make it testable.
Lessons: none for 44px/clearable beyond L-300 (send only touched fields — matches clearableField semantics), L-322.

## Row 182d — NOT LIVE (wording identical)
- Mobile `apps/mobile/app/(operator)/returns/[id].tsx:35-36` REFUND_METHOD_LABELS = "Store credit (credit note)" / "Refunded (cash / card / check)". Web `apps/web/app/(dashboard)/returns/[id]/page.tsx:83-86` has the exact same strings. Close.

## Row 211 — LIVE
- `apps/mobile/app/(customer)/orders/[id].tsx:212` `GST (10%): $...` hard-coded (tax amount `order.tax` is untouched). Web buyer page `apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx:814` shows plain `label: "Tax"`. No tax-rate label helper in packages/types/pricing used for this (counter-sale types have `taxRatePercent`, receipt.ts:46, not on order). Fix: label "Tax" (label-only, amount line unchanged). Pin: source-pin test in `__tests__` (fs read, assert no "GST (10%)"). Do not compute a rate from tax/subtotal.

## Row 285 — LIVE (partial; email already fixed)
- `apps/mobile/components/CustomerForm.tsx` payload ~:190-215: email handled (`mode==="edit" ? email : email||undefined`); still `|| undefined` for phone(:195), currency, notes, deliveryWindowStart/End, taxId (~:197-207). Web helper: `apps/web/lib/contact-person-payload.ts:9 clearableField(next, loaded): string|null|undefined` (trimmed value; null if loaded value emptied; undefined if nothing to clear). Mobile has no copy: add `apps/mobile/lib/clearable-field.ts` (same 3-line fn) + test `__tests__/clearable-field.test.ts`, then use `clearableField(form.x, initial?.x)` for edit mode only; create keeps `|| undefined`. Need the loaded customer object (initial) in the form — read how CustomerForm receives it. creditLimit/addresses out of scope.

## Row 440 — NOT LIVE
- Register: "mobile invoice review header says '24 items' for one boxed line (counts pieces, not lines)". Fixed: `__tests__/invoice-line-count.test.ts` header "Row 440 ... header and footer count LINES" via `apps/mobile/lib/invoice-line-count.ts` (`invoiceLineCount`, `lineCountLabel`). The manifest's file (invoices/[id].tsx:886) is the invoice DETAIL items card, unrelated. Close.

## Row 533a — NOT LIVE (likely fixed; touches qty display)
- Register (533): "mobile '417 Pack' vs web '417 pcs (69 boxes + 3 pcs)'". `apps/mobile/app/(operator)/purchase-orders/[id].tsx:219-225` already `linePack(item, product.unitsPerBox)` + `qtyLabel = isBoxed ? unitsLabel(qty, upb) : qty` (B699/B722/LANE-U). Any further change is qty/units conversion => OUT (HIGH). Items 533 b-g are separate unrouted bugs.
