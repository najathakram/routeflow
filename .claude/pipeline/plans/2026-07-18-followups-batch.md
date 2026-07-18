# Plan: Deferred follow-ups batch — ADVANCE restore, mobile parity, typings, pickers, pack-size prefill

> Authored by Fable 5 on 2026-07-18. Status: IMPLEMENTED (pipeline wf_345050f9-f20 clean; verify green; caught+fixed: ADVANCE void-then-delete double-restore; lint hint-text error fixed inline by orchestrator)
> This file is the ONLY context the implementation and review agents receive. It must stand alone.

## Objective

Close the deferred follow-ups from the shipping-fee / credit-notes / scanner batch:

1. **ADVANCE-payment orphan bug (money-critical)**: applying an advance decrements
   `AdvancePayment.balance` (customers.service.ts:891-894), but `deletePayment` /
   `voidPayment` never restore it — deleting/voiding an ADVANCE application permanently
   understates the customer's advance wallet while re-opening the invoice. Fix: restore the
   balance inline in the same tx (advances have no status machinery — unlike credit notes a
   plain `balance += amount` is complete). Also fix mobile's method-blind Void button.
2. **Mobile scan parity**: render the scan response's `candidates[]` as tap-to-link chips on
   unmatched lines; thread the scanned `sku` (and new `packSize`) into the mobile quick-create
   sheet.
3. **Mobile credit picker on order edit**: mirror NewOrderScreen's just-shipped "Apply
   credit" section on the operator edit-items screen (driver-gated off).
4. **admin.ts typing**: declare the fields the operator detail screens currently read via
   `as any` (all runtime-present already — server includes shipped).
5. **Web bill-detail picker**: swap the native 500-product `<select>` line editor to the
   async `SearchableProductPicker`.
6. **Pack-size OCR (prefill-only)**: extract `packSize` per line when the invoice clearly
   shows one; seed the create-product forms' units-per-box field as an EDITABLE prefill with
   a "verify" hint. Never auto-applied to existing products (units-per-box drives boxed money
   math — hallucination risk is why this was deferred; prefill-only is the safe shape).

No migration. No new dependencies.

## Constraints & conventions

- Prettier double quotes / printWidth 100; Jest for api+mobile (mobile = pure-logic tests
  only); mocks at module boundary; no unrelated reformatting.
- Money via `roundMoney` + `Number(...)` coercion of Prisma Decimals.
- Mobile mirrors web patterns; mobile has NO client-side role enforcement beyond UX gating —
  the API `@Roles` is the real gate.
- All server data used below is ALREADY returned by the live API (orderCreditNotes,
  invoices[].payments, payment.creditNote) — typing/UI only, except WP1/WP2 API changes.

## Work packages

### WP1 — API: restore AdvancePayment.balance on delete/void + specs

- **files:** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/invoices/invoices.service.spec.ts`
- **brief:** In `deletePayment` (~3477-3522) and `voidPayment` (~3694-3721), the CREDIT_NOTE
  guard exists (throws, pointing at unapply). ADVANCE currently falls through and corrupts
  the wallet. In BOTH methods, after the existing CREDIT_NOTE guard, add an inline restore
  BEFORE the delete/void write, inside the same tx:
  ```ts
  // ADVANCE applications debited AdvancePayment.balance when applied
  // (customers.service.applyAdvancePaymentToInvoice). Deleting/voiding the
  // application returns those dollars to the customer's advance wallet —
  // advances have no status machinery, so a balance increment is the complete
  // inverse. Without this the wallet is silently understated (the bug credit
  // notes had before their unapply primitive).
  if ((payment.method as any) === "ADVANCE" && (payment as any).advancePaymentId) {
    await tx.advancePayment.update({
      where: { id: (payment as any).advancePaymentId },
      data: { balance: { increment: roundMoney(Number(payment.amount)) } },
    });
  }
  ```
  Adapt the local variable names to each method. If either method's payment fetch does not
  select `advancePaymentId`, add it. VERIFY there is no payment-unvoid path that would need
  the symmetric re-decrement (`setCheckStatus` BOUNCED voids CHECK payments only; invoice
  `unvoid` does not flip payment statuses — confirm by reading, and state the finding in
  your report). Ensure both methods run inside a transaction (deletePayment already does;
  if voidPayment's write is not tx-wrapped with the restore, wrap the two writes together).
  Specs: delete of an ADVANCE payment increments the advance balance by the payment amount
  (roundMoney'd); void ditto; CREDIT_NOTE still refused in both; non-advance methods
  untouched (no advancePayment.update call).

### WP2 — API: OCR packSize extraction + types

- **files:** `apps/api/src/vendor-bills/vendor-bills.service.ts`,
  `apps/api/src/vendor-bills/vendor-bills.service.spec.ts`,
  `apps/api/src/import/batch-import.service.ts`
- **effort:** low
- **brief:** In the scan prompt's items schema (vendor-bills.service.ts ~606-614, after
  `"sku"`), add:
  `"packSize": units per box/case/pack as a number ONLY when the line explicitly shows one (e.g. "12x330ml" -> 12, "24 CT" -> 24, "1X6X4OZ" -> 6), else null — NEVER guess or infer,`
  The per-line `...item` spread already carries it through the response — no mapping code.
  batch-import.service.ts: add `packSize?: number | null` to the local `ScanLine` interface
  (type-only). Spec: scan response carries `packSize` through when the OCR JSON includes it;
  null/absent otherwise (extend the existing sku passthrough test pattern).

### WP3 — Web: bill-detail line editor → async picker

- **files:** `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx`
- **effort:** low
- **brief:** In `EditLineItems` (~339-477): delete the `useProducts({ limit: 500, isActive: true })`
  fetch (~349-350) and replace the native `<select>` (~366-391) with:
  ```tsx
  <SearchableProductPicker
    async
    value={row.productId}
    selectedLabel={row.description}
    placeholder="Search products… (or leave as custom item)"
    onChange={(id, product) =>
      product
        ? update(i, {
            productId: id,
            description: product.name,
            unitCost:
              (product as any).averageCost != null
                ? String(parseFloat(String((product as any).averageCost)).toFixed(4))
                : row.qty !== undefined
                  ? row.unitCost
                  : row.unitCost,
          })
        : update(i, { productId: "" })
    }
  />
  ```
  (Simplify the unitCost expression to match the existing select's logic exactly — it sets
  unitCost from `p.averageCost` when present, else keeps `row.unitCost`; the picker's clear
  action maps to the old "— Custom item —" option, i.e. `productId: ""` keeping the
  description.) Import the picker; keep everything else (incl. the InlineCreateProductModal
  create-from-line flow) unchanged.

### WP4 — Web: packSize threading + ProductCreateModal prefill

- **files:** `apps/web/lib/api/invoice-scan.ts`, `apps/web/lib/api/batch-import.ts`,
  `apps/web/components/ProductCreateModal.tsx`, `apps/web/components/ScanInvoiceModal.tsx`,
  `apps/web/components/BatchItemReviewModal.tsx`
- **effort:** low
- **brief:**
  1. `invoice-scan.ts`: `ScannedItem` += `packSize?: number | null;`. `batch-import.ts`: same
     on its scan-line type.
  2. `ProductCreateModal.tsx`: new optional prop `initialUnitsPerBox?: number`. Seed
     `unitsPerBox` in the initial `useState` (~88-102) and the open-resync effect (~107-123)
     with `String(initialUnitsPerBox)` when non-null AND `Number.isInteger(initialUnitsPerBox) && initialUnitsPerBox > 1`.
     Under the units-per-box field (~570-584), when the prefill is active and the field still
     equals it, render a small hint (same style as the existing "Suggested from invoice cost"
     hint): `Suggested from the invoice line ("{initialUnitsPerBox} per box") — verify before saving.`
     The field stays fully editable; nothing is auto-applied anywhere else.
  3. `ScanInvoiceModal.tsx` create-from-line call (~2091-2103): add
     `initialUnitsPerBox={reviewItems[createFromRow].packSize ?? undefined}` (thread
     `packSize` through the ReviewItem row shape from the scan response like `sku`).
  4. `BatchItemReviewModal.tsx` (~296-311): add
     `initialUnitsPerBox={lines[createFromRow]?.packSize ?? undefined}`.

### WP5 — Mobile: scan chips + sku/pack prefill

- **files:** `apps/mobile/app/(operator)/vendor-bills/scan.tsx`,
  `apps/mobile/components/InlineCreateProductSheet.tsx`,
  `apps/mobile/lib/api/vendor-bills.ts`
- **brief:**
  1. `lib/api/vendor-bills.ts`: `ScannedItem` += `packSize?: number | null;`.
  2. `scan.tsx` ReviewStep: in the unmatched-line actions block (~299-309, alongside
     Link/Create), when `item.candidates?.length`, render up to 3 suggestion chips —
     `Did you mean {c.name}? ({Math.round(c.score * 100)}%)` — each calling the existing
     `applyLink(index, c.productId, c.name)`. Style consistent with the existing
     lineActions buttons (smaller, brand-tinted; reuse the screen's StyleSheet patterns).
  3. `scan.tsx` create-from-line call (~356-372): add `initialCode={item.sku ?? undefined}`
     and `initialUnitsPerBox={item.packSize ?? undefined}` for the sheet.
  4. `InlineCreateProductSheet.tsx`: new optional prop `initialUnitsPerBox?: number`; seed
     `form.unitsPerBox` in the open-effect (~58-69) with `String(initialUnitsPerBox)` when
     integer > 1, alongside the existing prefills; add a one-line hint under the
     Pieces-per-box field when prefilled: `From the invoice line — verify.` Field stays
     editable.

### WP6 — Mobile: credit picker on operator edit-items

- **files:** `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`
- **brief:** Mirror `NewOrderScreen.tsx`'s "Apply credit" section (state ~419-429, payload
  ~864-865, UI ~1065-1114, styles `optionsWrap/optionsHeader/optionsTitle/optionsSummary/optionsBody/optionRow/optionLabel`)
  onto `EditOrderItemsScreen`:
  - `useCreditNotes({ customerId, status: "ISSUED", limit: 100 })` where
    `customerId = (order as any)?.customerId` (already read that way at ~131).
  - Initial selection = the ids in `(order as any)?.orderCreditNotes ?? []`
    (`.map((oc: any) => oc.creditNoteId)`), hydrated in the same effect that seeds the draft
    (~182-230) so it resets with the order. Track `creditsTouched` (set true on any toggle).
  - Rows: ALSO include credits already selected on the order even when not in the open list
    (so a fully-consumed applied credit still shows checked); display
    `creditNoteNumber · reason · $remaining` like NewOrderScreen.
  - **Driver-gated OFF**: render the section only when `!isDriver` (the same screen serves
    `app/(driver)/route/stop/[stopId]/edit-items.tsx`; drivers don't manage credits).
  - Save (~354-438): include `...(creditsTouched ? { appliedCreditNotes: selectedIds.map((id) => ({ creditNoteId: id })) } : {})`
    in the `updateMut.mutate` payload — and CRITICALLY: when the item diff is empty but
    `creditsTouched`, do NOT early-return (`~403-406` currently `leaveEditor()`s on an empty
    diff) — still call `updateMut.mutate({ orderId: id, items: [], replaceAll: false, appliedCreditNotes: ... })`
    (`replaceAll: false` is already passed — it is what makes an empty items array safe; the
    fee-only-publish data-loss bug on web came from omitting it).
  - `undefined` (untouched) keeps server-side intents — that is the API contract.

### WP7 — Mobile: admin.ts typing, cast removal, method-aware void flag

- **files:** `apps/mobile/lib/api/admin.ts`, `apps/mobile/lib/payments-logic.ts`,
  `apps/mobile/app/(operator)/payments/[id].tsx`,
  `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`,
  `apps/mobile/__tests__/payments-logic.test.ts` (locate the actual payments-logic test by
  grep; create alongside existing **tests** patterns if none exists)
- **effort:** low
- **brief:**
  1. `admin.ts` — additive type widening (all fields are runtime-present already):
     `AdminOrder` += `customerId: string;`,
     `orderCreditNotes?: Array<{ id: string; creditNoteId: string; amount?: number | string | null; creditNote?: { id: string; creditNoteNumber: string; reason?: string | null; amount: number | string; amountUsed?: number | string; status: string; expiresAt?: string | null } }>;`
     widen `invoices?` entries with `payments?: Array<{ id: string; amount: number | string; creditNoteId?: string | null }>;`
     and `lineItems[].product` with `averageCost?: number | string | null; category?: string | null;`.
     `AdminInvoice.payments[]` += `creditNote?: { id: string; creditNoteNumber: string; reason?: string | null } | null; creditNoteId?: string | null; advancePaymentId?: string | null;`.
  2. Remove the now-unneeded `as any` casts at `orders/[id].tsx` ~651-676 and
     `invoices/[id].tsx` ~478-483 (plus the ~478 "isn't in the admin.ts payment type yet"
     comment). Leave other casts alone.
  3. `payments-logic.ts` `paymentActionFlags` — make it method-aware:
     `paymentActionFlags(status, method?)` → `canVoid: status !== "VOID" && method !== "CREDIT_NOTE"`
     (ADVANCE stays voidable — WP1 makes it restore the wallet correctly). Update the caller
     `payments/[id].tsx` (~43) to pass the payment's method; a CREDIT_NOTE payment shows no
     Void button (matches the API refusal + web behavior). Keep backward-compatible optional
     param so other callers (if any — grep) compile.
  4. Test: `paymentActionFlags` — VOID status → no void; CREDIT_NOTE method → no void;
     ADVANCE/CASH → voidable. Extend the existing payments-logic test file if present,
     else create one following the repo's pure-logic test style.

## Acceptance criteria

1. Deleting or voiding an ADVANCE `InvoicePayment` increments the source
   `AdvancePayment.balance` by the payment amount in the same tx; CREDIT_NOTE payments are
   still refused in both paths; other methods behave exactly as before.
2. The OCR prompt requests `packSize` (explicit-only, never guessed); scan responses carry
   it additively (web + mobile + batch types compile).
3. Web bill-detail line editor searches the whole catalog asynchronously; selected labels
   render from `row.description`; the custom-item path still works; create-from-line flow
   unchanged.
4. `ProductCreateModal` and `InlineCreateProductSheet` accept `initialUnitsPerBox`, seed the
   editable field (integer > 1 only) with a "verify" hint, and both scan create-from-line
   call sites (web) + the mobile sheet call site pass sku/packSize prefills.
5. Mobile scan review shows up to 3 candidate chips on unmatched lines; tapping links the
   line exactly like the picker path.
6. Mobile operator edit-items shows the Apply-credit section (hidden for drivers),
   pre-checked from the order's existing intents, sends `appliedCreditNotes` only when
   touched, and a credits-only edit (empty item diff) still saves with `replaceAll: false`.
7. `admin.ts` types cover `customerId`/`orderCreditNotes`/`invoices[].payments`/
   `payments[].creditNote`; the listed `as any` casts are gone; mobile Void is hidden for
   CREDIT_NOTE payments.
8. `npm run verify` green; no migration; no new deps.

## Verification commands

- `npm run verify`

## Risks & rollback

- The ADVANCE restore is the only money-path change: it is a strict improvement (wallet was
  being silently drained) and reviewers should confirm no payment-unvoid path exists that
  would need the symmetric re-decrement.
- Mobile edit-items empty-diff save: verify the API treats `items: []` + `replaceAll: false`
  as "no line changes" (the merge branch iterates zero items) — the web publish path already
  relies on exactly this.
- packSize is prefill-only; nothing writes unitsPerBox without the operator seeing/confirming
  the form field.
- Rollback: revert the commit — no schema changes.
