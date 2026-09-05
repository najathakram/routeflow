# F09 · Spec — credit notes and wallet integrity

**Status: IN PROGRESS** · Scale: major (money + tenancy-adjacent, 3+ files). Scope: exactly
B13, B18, B19, B66, B67. Money math via `pricing.ts` helpers only. **No schema change, no
migration.** Conventions: NestJS `Test.createTestingModule`, module-boundary mocks, Prettier.

## Requirements

### B67 — wallet credit never reaches forgiven debt (the primitive)

- **R1 (P0, jest):** `settleOrderCreditsInTx`'s invoice query excludes **WRITTEN_OFF** as well
  as VOID.
- **R2 (P0, jest):** the exclusion holds for **every** caller of the primitive, including the
  two `send()` / `sendEmail()` call sites F07 added. Proven by testing the primitive, not by
  six call-site tests.
- **R3 (P0, jest):** **PAID stays IN the settle set — and this is the requirement most likely
  to be "simplified" into a bug.** Reading the code changed this design: the two obvious
  candidates for reuse, `applyToInvoice`'s `notApplicableStatuses` (`[PAID, VOID,
  WRITTEN_OFF]`) and `recordDeliveryPaymentInTx`'s `PAYABLE` (`[DRAFT, SENT, PARTIAL,
  OVERDUE]`), **both exclude PAID** — and `settleOrderCreditsInTx` runs a **shrink** pass over
  the very same invoice list before its apply pass. Excluding PAID would stop an order edit
  from un-applying now-excess credit on a PAID invoice, stranding customer money. Including
  PAID in the apply pass is harmless: `applyCreditInTx` clamps to the remaining balance, which
  is zero. So the settle set is genuinely its own set, and adopting either existing list
  verbatim would trade B67 for a new defect.
- **R3a (P0):** the three sets therefore live in ONE shared, named module with the reason each
  differs written down — e.g. `apps/api/src/invoices/invoice-status-sets.ts` exporting
  `CREDIT_NOT_APPLICABLE` (manual apply: PAID/VOID/WRITTEN_OFF), `CREDIT_SETTLE_EXCLUDED`
  (automatic settle: VOID/WRITTEN_OFF only, because it also shrinks) and `PAYABLE`. Existing
  call sites are re-pointed at the shared constants with no behaviour change. **Four
  independently hand-rolled status filters is how B67 exists**; the fix is one home with the
  distinction documented, not a fourth list.

### B66 — a credit note cannot outlive or precede its source invoice's death

- **R4 (P0, jest):** `create()` selects the source invoice's `status` and **refuses** to mint a
  credit note against a VOID (or DRAFT) invoice, with a message naming the status. Behaviour for
  a live invoice is byte-identical, including the existing over-credit cap.
- **R5 (P0, jest):** `voidInvoiceInTx` **caps or voids** credit notes sourced from the invoice
  being voided: for each `CreditNote` with `invoiceId === <voided invoice>`, the **unused**
  portion (`amount − amountUsed`) is removed — a fully-unused note becomes VOID, a partly-used
  note is capped to `amountUsed` (already-spent money is not clawed back; that would corrupt
  invoices the credit already paid). Runs **inside** the existing void transaction.
- **R6 (P1, jest):** already-applied credit is untouched by R5 — no `InvoicePayment` is deleted
  and no `amountUsed` decremented. R5 removes only *spendable* headroom.

### B18 — delete the flow that can never run (web + mobile + API)

- **R7 (P0, e2e T2 + code removal):** every DRAFT/Issue affordance is removed: web
  `[id]/page.tsx` (both `status === "DRAFT"` blocks, `IssueConfirmModal`, the
  `useIssueCreditNote` usage), mobile (`[id].tsx` hook usage, `index.tsx` "Draft" filter chip,
  `new.tsx` DRAFT case), both client hooks, and the API's no-op `issue()` service method plus
  its `@Post(":id/issue")` route. Safe: `status` can never be DRAFT, so no client can reach it.
- **R8 (P1):** no remaining reference to a DRAFT credit-note status anywhere outside the
  register/docs. Enum untouched (it never had DRAFT).

### B19 — invoice numbers, not UUIDs

- **R9 (P0, jest + e2e T2):** `findAll` includes `invoice: { select: { id: true,
  invoiceNumber: true } }`, matching `findOne`'s existing shape.
- **R10 (P0, e2e T2):** all three web render sites show `invoice?.invoiceNumber ?? invoiceId`:
  list `page.tsx` ~:855, detail ~:508-516 and ~:638-646. The `href` keeps using the id.

### B13 — web can apply a customer advance

- **R11 (P0, e2e T2):** the web invoice detail page gains an **Apply advance** action mirroring
  mobile's `ApplyAdvanceSheet`, wired to the existing `useApplyAdvanceToInvoice`. It is shown
  only when the customer has an advance balance > 0 and the invoice has a positive balance.
- **R12 (P1):** the duplicate `useApplyAdvancePayment` in `apps/web/lib/api/customers.ts` is
  deleted — same endpoint, same params, weaker invalidation, zero callers.

## Deploy-day / entitlement answers

No flags, no entitlements, no migration, no backfill for the CODE. **Existing data is D4**
(post-merge, owner-gated): credits already sourced from voided invoices, and credit already
consumed against WRITTEN_OFF debt. Rollback = revert the single PR; no persisted-shape change.

Behaviour deltas an operator sees on deploy day: (1) creating a credit note against a voided
invoice is refused with a reason; (2) voiding an invoice now also removes the unused headroom of
credits it sourced; (3) the never-working Issue button disappears; (4) invoice numbers replace
UUIDs; (5) a new Apply-advance action appears on web.

## Non-goals

A real DRAFT lifecycle (D5-deferred) · clawing back already-spent credit · touching
`applyToInvoice`'s manual guards · F08's scope in the same file · retro-repair in code.
