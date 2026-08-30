# Invoicing & Getting Paid

_Turn a delivered order into a correct bill, get it in front of the customer, and know at any
moment who owes what._

## The problem

A wholesale distributor bills late and bills wrong. The driver writes what actually came off the
truck in a paper book, someone re-keys it into a spreadsheet that evening, the invoice goes out a
day or three later as a WhatsApp photo, and the same numbers get typed a third time into the
accounting package at month end. Every re-keying is a chance to price a case as a piece, forget
the short-delivery, or lose the invoice entirely. Collection is then run from memory: cheques,
cash at the door, Zelle and card arrive in no particular order, get applied to whichever invoice
someone remembers, and the customer's balance becomes an argument instead of a fact. Nobody can
answer "who owes us what, and for how long" on any given morning without an hour of spreadsheet
work.

## Why it matters to a tenant

The bill is created from the same line-level data the order and the delivery already used, so it
exists the moment goods are billed instead of three days later, and the boxed line that should be
$350 cannot silently become $420 because all three surfaces route through one
`computeLineSubtotal`/`roundMoney` implementation (`apps/api/src/common/pricing.ts` plus the web
and mobile mirrors). Every dollar that arrives — driver cash at the door, a cheque that later
bounces, a card payment the buyer makes themselves in the portal — lands as one `InvoicePayment`
row that recomputes invoice status, the customer's balance, and AR aging in the same breath. The
tenant gets a real receivables position (aging buckets, time-to-get-paid, bad-debts) and a
downloadable monthly customer statement instead of a reconstruction exercise.

## Core use cases

1. **Bill what was actually delivered** — turn a delivered (or partly delivered) order into a
   correct, sendable invoice — right quantities, right boxed/piece pricing, right tax, right due
   date — without anyone re-typing it.
2. **Get the bill to the customer and keep an honest running balance** — issue the document
   (PDF/email/portal), then record every payment that arrives from any channel so the invoice
   status and the customer's balance are always the same number everyone else sees.
3. **Know and chase what is owed** — see outstanding balances by age and by customer, send
   reminders or statements, and close the loop with a write-off when a debt is genuinely dead.

## Must have (P0)

| ID      | Capability                                                                            | Status     | What it does                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-M1  | Invoice generated from a delivered order (full, partial, regulated-split)             | PARTIAL 🟡 | Marking an order delivered produces the invoice from the order's own lines, including partial billing and sibling invoices for regulated categories.                   | `POST /invoices/from-order/:orderId` (+`/partial`); `invoices.service.ts` `createInvoiceFromOrder`, `createSplitInvoices`, `createPartialFromOrder`. PARTIAL because bug register B105: the auto-invoice on Mark-delivered is fire-and-forget — a failure leaves a delivered, never-billed order with no retry surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| INV-M2  | Create a standalone invoice by hand                                                   | SHIPPED ✅ | An operator raises an invoice for a customer with freeform or product-linked lines, discounts, shipping, notes and terms, without an order behind it.                  | `POST /invoices`; `invoices.service.ts` `create()` — resolves box sizes, normalizes boxes/pieces, applies BOGO, snapshots regulated category tax, 409s on invoice-number collision. Web `invoices/new`; mobile `invoices/new.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| INV-M3  | Unique, sequential, tenant-scoped invoice numbering                                   | BROKEN 🔴  | Every invoice gets a human-readable number unique within the tenant, never reused or colliding under concurrency.                                                      | `generateInvoiceNumber` (`invoices.service.ts`) uses the raw `PrismaService`, not `forTenant()` — the max+1 scan reads across ALL tenants, then writes against a per-tenant unique constraint. Zero-padded to 4 digits, jams past 9999/year. Bug register B100 (High, Open). A configurable `NumberingSequence` exists but `reserveNext` is not wired into live minting.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| INV-M4  | Invoice status lifecycle (DRAFT→SENT/VIEWED, PARTIAL, PAID, OVERDUE/VOID/WRITTEN_OFF) | PARTIAL 🟡 | The invoice's state reflects reality without payment activity silently overriding a deliberate state.                                                                  | `InvoiceStatus` enum; `recomputeStatus` treats DRAFT/VOID/WRITTEN_OFF as terminal, derives PAID/PARTIAL/OVERDUE/SENT from non-VOID payments, and **is invoked — and its result persisted — from every payment-mutating call site** (`recordPayment`, void/delete payment, check-status transitions, `updateTerms`). `markOverdue()` itself has no scheduled caller anywhere in the repo (confirmed by repo-wide grep including `scripts/`), so a quiet invoice with no payment activity never flips to OVERDUE on its own; `findAll` re-derives overdue per read as a second definition. verified: half of the original "decorative" framing overstated the gap — stored OVERDUE is written routinely on activity, just not backfilled for quiet invoices; the two-definitions problem is real but sharper than "never written." |
| INV-M5  | Money math correct once, everywhere (boxed proration, tax, rounding)                  | SHIPPED ✅ | Line totals, tax, discounts and the document total are computed by one shared implementation across invoice, order, PDF, email and mobile.                             | `apps/api/src/common/pricing.ts` mirrored at `apps/web/lib/pricing.ts` / `apps/mobile/lib/pricing.ts`; regression spec `pricing.spec.ts`. Tax derived from each line's stored post-discount subtotal; tax-exempt customers get $0 for regular and regulated tax.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| INV-M6  | Payment terms and due dates that agree with each other                                | SHIPPED ✅ | A structured Net-N term resolves the due date; defaults cascade customer → tenant → Net 30; the printed label can never contradict the arithmetic.                     | `resolveDefaultTerms` (customer default beats tenant default beats "Net 30"); every from-order path anchors `dueDate = issueDate + termDays`; a hand-edited `dueDate` clears the label. `PATCH /invoices/:id/terms`. Settings at `GET/PATCH /settings/invoice`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| INV-M7  | Record payments — part payments, multiple methods, one invoice or many                | SHIPPED ✅ | Cash, cheque, ACH, card, Zelle or other money is recorded with a payment number, reference, optional receipt image, and a settlement date distinct from date received. | `POST /invoices/:id/payments` and `/invoices/payments/record`; `recordPayment` (row-level lock, over-payment guard, `PaymentCounter`-based numbering), `recordStandalonePayment`, `recordDeliveryPaymentInTx`. `PaymentMethod` enum incl. ZELLE/CREDIT_CARD. Payment images via `/invoices/payments/:paymentId/image`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| INV-M8  | Send the invoice to the customer (email with PDF, portal, mark-as-sent)               | BROKEN 🔴  | Issuing the invoice flips it to SENT and gets the document to the customer by email with the PDF, or via the buyer portal.                                             | `POST /invoices/:id/send` and `/send-email`; `send`/`sendEmail` commit the DRAFT→SENT flip and oldest-first credit auto-apply in one Serializable transaction, fire `INVOICE_SENT` (EMAIL+PORTAL only, rule G12). BROKEN per bug register B102: `buildInvoiceEmail` takes only `total` — no paid/balance — so a part-paid invoice's email shows the full total as amount due (confirmed in source: `email.service.ts` L842-863, no paid/balance parameter).                                                                                                                                                                                                                                                                                                                                                                      |
| INV-M9  | A customer-facing invoice document (PDF, draft vs final)                              | PARTIAL 🟡 | A branded PDF with a clear DRAFT (pre-delivery proforma) vs FINAL stage so nobody pays off a provisional document.                                                     | `GET /invoices/:id/pdf?variant=draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | final`; `invoice-pdf.service.ts`renders fresh every call;`deriveInvoiceVariant`triple-mirrored (api/web/mobile). Branding from`TenantConfig`. verified: the bug-register premise (B97 — PDF folds unconfirmed DRAFT payments into Balance Due) is **false** — `invoice-pdf.service.ts`already loads payments`where: { status: { not: "VOID" } }`, identical to the `findOne`/`findAll` rule (`status !== "VOID"`), so the PDF does not disagree with any other surface. Remaining real shortfall: B103 presentation parity (promo strikethrough / BOGO disclosure not shown on PDF/email) and unverified draft-watermark behavior — kept at PARTIAL, not BROKEN. |
| INV-M10 | Cancel, correct or reverse a wrong invoice                                            | PARTIAL 🟡 | Void (returning wallet money), revert to DRAFT, un-void, reopen, or duplicate as the basis for a corrected invoice.                                                    | `POST /invoices/:id/{void,revert-to-draft,unvoid,reopen,duplicate}`; `externalPaidOn` splits wallet money (returnable) from external money (blocks the void); `voidInvoiceInTx` (status→VOID, releases invoiced qty, ledger reversal). PARTIAL: bug register B84 — no status guard or atomic claim on void, so a double-void double-releases `invoicedQty`; B66 — credit notes outlive their source invoice's void.                                                                                                                                                                                                                                                                                                                                                                                                              |
| INV-M11 | Receivables position: what is outstanding, by age and by customer                     | PARTIAL 🟡 | A single answer to "who owes us what, and how old is it" — aging buckets, per-customer balances, DSO, time-to-get-paid.                                                | `GET /bookkeeping/finance-dashboard` (ungated) returns `arAging` buckets. `GET /bookkeeping/reports/*` (aging, ar-aging-invoices, customer-balance, bad-debts, time-to-get-paid, etc.) all gated by `flag.reports`. PARTIAL: bucket boundaries hardcoded; deposits invisible to aging (B87); windowed DSO excludes still-unpaid invoices (B119).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| INV-M12 | Tenant isolation on every invoice and payment read and write                          | PARTIAL 🟡 | One tenant can never see, list, export or mutate another tenant's invoices, payments, statements or PDFs.                                                              | `PrismaService.forTenant()` used throughout `invoices.service.ts`; nested `InvoiceItem`/`InvoicePayment` creates stamp `tenantId` explicitly. Security spec `invoices.security.spec.ts`. PARTIAL: `generateInvoiceNumber` uses the raw client and reads every tenant's numbers (B100, see INV-M3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| INV-M13 | Edit an unissued invoice's lines, discounts, shipping and notes                       | SHIPPED ✅ | Before an invoice is sent, its lines, discounts, shipping and notes can be corrected through the normal money pipeline rather than voided and redone.                  | `PATCH /invoices/:id` → `update()` enforces "Only DRAFT invoices can be edited" plus `assertOrderInvoiceUnlocked`, rebuilds every line through `normalizeBoxesPieces`/`computeLineSubtotal`, re-snapshots regulated category tax and re-runs `applyMsrpSnapshots`. Web `invoices/[id]/edit`; mobile `invoices/[id]/edit.tsx`. missedCapability, added at verification (MUST).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| INV-M14 | Correct or reverse an individual payment; delete an unpaid invoice                    | SHIPPED ✅ | A payment recorded against the wrong invoice or the wrong amount can be edited, voided, or deleted; an invoice with no payments can be deleted outright.               | `PATCH /invoices/:id/payments/:paymentId` → `updatePayment` (distinguishes a missing `settledAt` key from an explicit null); `PATCH /:id/payments/:paymentId/void` → `voidPayment` (OPERATOR-only, recomputes status); `DELETE /:id/payments/:paymentId` → `deletePayment`; `DELETE /:id` → `deleteInvoice` (refuses when any payment exists, releases invoiced qty before reversing the regulated ledger). missedCapability, added at verification (MUST).                                                                                                                                                                                                                                                                                                                                                                      |

### Testing criteria

#### INV-M1

- [ ] Jest (api): an order with 3 lines where only line 1 is billed produces an invoice containing exactly that line, and `OrderItem.invoicedQty` for line 1 increases by the billed qty while lines 2-3 stay at 0. `Jest`
- [ ] Jest (api): billing the same order line twice for more than its ordered qty is rejected with 4xx and no second `InvoiceItem` row is written. `Jest`
- [ ] Jest (api) money invariant: for a mixed order split across a standard group and a regulated group, the sum of sibling invoice totals equals `order.total` exactly, with the largest-subtotal group absorbing any rounding remainder. `Jest`
- [ ] Jest (api) money invariant: a boxed line bills `computeLineSubtotal(...)`, never `qty*unitPrice` — assert the stored subtotal is not 12x the boxed value. `Jest`
- [ ] Jest (api): when invoice creation throws inside the delivery path, the order is NOT left DELIVERED-with-no-invoice silently. `Jest`

#### INV-M2

- [ ] Jest (api): a line whose discount exceeds its line total is rejected 4xx naming the line, and no Invoice row is persisted. `Jest`
- [ ] Jest (api): an invoice-level discount greater than the subtotal, or a computed negative total, is rejected 4xx. `Jest`
- [ ] Jest (api) money invariant: `total === roundMoney(subtotal - discount + shippingFee + taxAmount)`, at most 2 decimal places everywhere. `Jest`
- [ ] Jest (api) tenant isolation: `create()` for a customerId in another tenant 404s, no Invoice is written. `Jest`
- [ ] Playwright (web): submitting the new-invoice form with an empty line set shows a validation error and issues no POST. `Playwright`

#### INV-M3

- [ ] Jest (api) tenant isolation: with tenant A holding INV-2026-0900, a create in tenant B mints INV-2026-0001, not INV-2026-0901. `Jest`
- [ ] Jest (api): with 10000 existing invoices in one year, the next mint returns 5-digit INV-YYYY-10000 without repeating 9999. `Jest`
- [ ] Jest (api): two concurrent `create()` calls on the same tenant never produce duplicate numbers or a 500. `Jest`
- [ ] Jest (api): once `NumberingSequence` is wired, PATCH of prefix/padding changes the next number and never re-issues one already used. `Jest`

#### INV-M4

- [ ] Jest (api): a full payment flips status to PAID and stamps `paidAt`; a smaller one flips to PARTIAL. `Jest`
- [ ] Jest (api): a payment on a DRAFT invoice does not move it off DRAFT. `Jest`
- [ ] Jest (api): a VOID payment is excluded from `paidAmount` in both `findOne` and `findAll`, and the invoice re-opens accordingly. `Jest`
- [ ] Jest (api): an invoice due yesterday with balance > 0 reports `isOverdue=true`; one due TODAY reports `false`. `Jest`
- [ ] Jest (api): either `markOverdue()` gains a scheduled caller, or the stored OVERDUE status is documented as non-authoritative so the two definitions cannot drift. `Jest`

#### INV-M5

- [ ] Jest (api) invariant: `total === roundMoney(subtotal - discount + shippingFee + taxAmount)` and `taxAmount` matches the line-level sum. `Jest`
- [ ] Jest (api): a boxed line billed across three partials prorates telescopically to the cent. `Jest`
- [ ] Jest (api): a tax-exempt customer's `taxAmount === 0` and every `categoryTaxAmount === 0`. `Jest`
- [ ] Jest (api): a price-override line is not double-discounted. `Jest`
- [ ] Jest (api): the three pricing.ts mirrors produce identical outputs on a shared fixture table. `Jest`

#### INV-M6

- [ ] Jest (api): a customer term overrides the tenant default and resolves the correct `dueDate`/label. `Jest`
- [ ] Jest (api): a backdated order anchors `issueDate`/`dueDate` to the order date, not "now". `Jest`
- [ ] Jest (api): an explicit `dueDate` override clears `paymentTermsLabel` to null. `Jest`
- [ ] Jest (api): terms PATCH on VOID/WRITTEN_OFF is refused 4xx; on PAID it succeeds and re-runs `recomputeStatus`. `Jest`

#### INV-M7

- [ ] Jest (api): a payment of remaining + $0.01 is rejected 4xx, no row created. `Jest`
- [ ] Jest (api): recording CREDIT_NOTE/ADVANCE via the generic payment endpoint is rejected — dedicated apply actions required. `Jest`
- [ ] Jest (api) money invariant: `balanceDue === roundMoney(total - sum of non-VOID payments)`. `Jest`
- [ ] Jest (api) idempotency: two identical POSTs with the same client identifier should produce one payment row — currently no idempotency key exists (documents the gap). `Jest`
- [ ] Jest (api) tenant isolation: `GET /invoices/payments/:paymentId` for another tenant's payment 404s. `Jest`

#### INV-M8

- [ ] Jest (api): sending an invoice with $40 recorded against $100 produces an email amount-due of $60, not $100. `Jest`
- [ ] Jest (api): `send()` on an already-SENT invoice is idempotent — no re-fire, no second credit auto-apply. `Jest`
- [ ] Jest (api): with no email configured, `/send-email` 4xxs and status is NOT flipped to SENT. `Jest`
- [ ] Jest (api): a customer with an import-sentinel email is treated as having none — 4xx, no send attempt. `Jest`
- [ ] Jest (api): `INVOICE_SENT` over WhatsApp/SMS is refused with no dispatch. `Jest`

#### INV-M9

- [ ] Jest (api): a PDF rendered for an invoice with a DRAFT-status payment excludes it from Balance Due exactly like `findOne`/`findAll` do — assert parity, not a PDF-only fix. `Jest`
- [ ] Jest (api): `deriveInvoiceVariant` returns identical results from all three mirrors on the same fixtures. `Jest`
- [ ] Playwright (web): the Draft|Final toggle changes the variant on Print/Download/Email, draft render carries the watermark. `Playwright`
- [ ] Jest (api): a long Terms & Conditions block wraps across pages rather than clipping. `Jest`
- [ ] Manual: MSRP prints under Unit Price when present; blank (never $0.00) when null. `manual`

#### INV-M10

- [ ] Jest (api): voiding an invoice paid only by a credit note restores the credit note's balance. `Jest`
- [ ] Jest (api): voiding an invoice with $1 of cash recorded is rejected 4xx, invoice untouched. `Jest`
- [ ] Jest (api) invariant: calling void twice releases `invoicedQty` exactly once. `Jest`
- [ ] Jest (api): revert-to-draft with payments is refused; on a clean SENT invoice it succeeds and re-syncs sales-agent accrual. `Jest`
- [ ] Jest (api) tenant isolation: void on another tenant's invoice 404s and mutates nothing. `Jest`

#### INV-M11

- [ ] Jest (api) invariant: sum of `arAging` buckets equals sum over non-terminal invoices of `(total - non-VOID payments)`. `Jest`
- [ ] Jest (api): a bounced cheque does not reduce the customer's receivable. `Jest`
- [ ] Jest (api): a WRITTEN_OFF invoice is excluded from receivables and appears in bad-debts, in exactly one place. `Jest`
- [ ] Jest (api) entitlement: a tenant without `flag.reports` 403s on `/reports/*` but 200s on `/finance-dashboard`. `Jest`
- [ ] Playwright (web): aging tiles sum to the outstanding-receivables figure shown alongside them. `Playwright`

#### INV-M12

- [ ] Jest (api): `GET /invoices/:id`, `/pdf`, `/payments/:paymentId`, `DELETE /invoices/:id` all 404 for another tenant's row. `Jest`
- [ ] Jest (api): `GET /invoices` in tenant A returns zero rows from tenant B, including imported invoices with null `tenantId` on nested items. `Jest`
- [ ] Jest (api): the payments CSV export contains no row from another tenant. `Jest`
- [ ] Jest (api): invoice-number minting reads only the caller's tenant (currently failing — see INV-M3). `Jest`
- [ ] Playwright (web): a CUSTOMER-role token sees only their own customer's invoices, never a DRAFT one. `Playwright`

#### INV-M13

- [ ] Jest (api): editing a SENT or later invoice via `PATCH /invoices/:id` is rejected 4xx. `Jest`
- [ ] Jest (api): editing lines on a DRAFT invoice re-runs `normalizeBoxesPieces`/`computeLineSubtotal` and re-snapshots MSRP/regulated tax. `Jest`
- [ ] Jest (api): editing an order-linked DRAFT invoice respects `assertOrderInvoiceUnlocked` and does not desync the order. `Jest`
- [ ] Playwright (web): the edit screen is unreachable (or shows a clear refusal) once the invoice leaves DRAFT. `Playwright`

#### INV-M14

- [ ] Jest (api): `updatePayment` distinguishes an omitted `settledAt` (preserve) from an explicit null (clear). `Jest`
- [ ] Jest (api): `voidPayment` is OPERATOR-only and recomputes invoice status afterward. `Jest`
- [ ] Jest (api): `deleteInvoice` refuses when any payment exists on the invoice. `Jest`
- [ ] Jest (api): deleting an unpaid invoice releases `invoicedQty` and reverses the regulated ledger in one transaction. `Jest`

## Nice to have (P1)

| ID      | Capability                                                                     | Status     | What it does                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INV-N1  | Deposits — X% up front, remainder on terms                                     | PARTIAL 🟡 | Ask for a deposit at order placement or on the invoice, tenant/customer default or one-off percentage, printed on the document.                                             | `Invoice.depositPercent`/`depositDueDate`; `Customer.defaultDepositPercent`; tenant keys `invoice.depositDefaultPercent`/`depositCollectAtOrder`. `computeDepositFields` derives amount at read time. PARTIAL: deposits are deliberately invisible to `recomputeStatus` and AR aging (B87).                                                                                                                                                                                                                                                                                                                                                                              |
| INV-N2  | Credit notes applied to invoices, auto-applied oldest-first at send            | SHIPPED ✅ | A customer's open credit is offered against their bill automatically at send, oldest first, never over- or double-applied.                                                  | `credit-notes.service.ts` `applyCreditInTx`, `autoApplyOldestCreditsInTx` (called from `send`/`sendEmail` in the same transaction as DRAFT→SENT), `releaseInvoiceCreditsInTx`, `restoreCreditFromPaymentInTx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| INV-N3  | Customer advances / prepayment wallet applied to invoices                      | PARTIAL 🟡 | Money taken before the goods is held as a customer balance and drawn down against later invoices.                                                                           | `AdvancePayment` model; `POST /customers/:id/advance-payments`; `releaseWalletPaymentsInTx` re-credits on void. PARTIAL: bug register B13 — the web hook `useApplyAdvanceToInvoice` has zero callers in `apps/web/app`, so an advance cannot be applied from the web invoice screen (mobile has the credit-note equivalent).                                                                                                                                                                                                                                                                                                                                             |
| INV-N4  | Cheque lifecycle and NSF handling                                              | SHIPPED ✅ | Track a cheque Recorded→Deposited→Cleared, or mark Bounced — reversing payment, optionally billing an NSF fee, reopening the invoice.                                       | `PATCH /invoices/:id/payments/:paymentId/check-status` (OPERATOR-only); `setCheckStatus` with a forward-only transition map; BOUNCED flips the payment to VOID, optionally adds a taxRate:0 NSF line, recomputes status.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| INV-N5  | Bank-settlement date separate from date received                               | SHIPPED ✅ | A post-dated cheque or in-flight ACH is recorded when received but reported in the period the money actually landed.                                                        | `InvoicePayment.settledAt`, distinct from `paidAt`/`clearedAt`; spread into `getCashFlow` and the payments-received report only; AR aging, statements and time-to-get-paid deliberately stay on their documented dates.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| INV-N6  | Payment reminders                                                              | PARTIAL 🟡 | Nudge a customer about an unpaid invoice without re-issuing it.                                                                                                             | `POST /invoices/:id/send-reminder` refuses VOID/PAID, filters sentinel addresses, fails loudly with no email configured. PARTIAL: entirely manual and email-only; `PAYMENT_REMINDER` is permitted on all channels in settings but has no caller anywhere in `apps/` — a configurable toggle that governs nothing. Same B102 amount-due defect as INV-M8.                                                                                                                                                                                                                                                                                                                 |
| INV-N7  | Recurring invoices                                                             | BROKEN 🔴  | A standing bill generates on a schedule and can optionally email itself.                                                                                                    | Cron `generateDueRecurringInvoices` claims the cycle before creating, then delegates to `InvoicesService.create`. BROKEN: B46 (Critical) — MONTHLY templates re-fire every midnight, producing a duplicate invoice and email per day; B106 (High) — the cycle is claimed before creation, so a failed run is silently reported as successful. Template editing itself is not missing: `PATCH /recurring-invoices/:id` and `update()` exist with an unused web hook `useUpdateRecurringInvoice` — the gap is only the missing edit screen, not the endpoint (verified against the original B92 "cannot be edited" claim, which was overstated).                           |
| INV-N8  | Customer statement — operator and buyer, downloadable monthly PDF              | PARTIAL 🟡 | A period statement showing opening balance, invoices raised, payments received and closing balance, available to the operator and self-serve to the buyer.                  | `GET /customers/:id/statement(s)`; buyer twins `GET /buyer/statement(s)` computing opening/closing receivable independently as ground truth. PARTIAL: bug register B110 — Outstanding/Overdue silently drop unpaid invoices past a 100-invoice cap.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| INV-N9  | Buyer self-serve payment (card via Stripe Connect, or a declared cash payment) | PARTIAL 🟡 | The customer pays their own bill from the portal — by card on the seller's Stripe account, or by declaring cash the seller approves — settling oldest invoices first.       | `GET/POST /buyer/payments/*`; `payment-requests.service.ts` `buildOldestFirstAllocation`; card lifecycle PENDING→SETTLING→SETTLED via webhook, non-reopening; `settleByPaymentIntent` is the only money entry point. PARTIAL: B44 — mobile buyers cannot pay online. verified/expanded: the mobile gap is confirmed narrower than described — `apps/mobile/lib/api/buyer.ts` has only `GET /buyer/payments`, `GET /buyer/invoices`, `GET /buyer/statement(s)`, and no POST card/cash endpoints anywhere; mobile OPERATOR invoicing itself is much fuller (edit, record-payment, write-off, payment-edit screens all exist) — only the BUYER side of mobile is read-only. |
| INV-N10 | Write-off of an uncollectable invoice, with a bad-debt report                  | SHIPPED ✅ | Formally stop chasing a debt without deleting the history, and see the total written off.                                                                                   | `POST /invoices/:id/write-off` — allowed only from SENT/VIEWED/PARTIAL/OVERDUE, stamps reason and timestamp in a transaction, re-syncs commission accrual. WRITTEN_OFF is terminal in `recomputeStatus`. `GET /bookkeeping/reports/bad-debts`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| INV-N11 | Payments register, export and receipt images                                   | PARTIAL 🟡 | One list of every payment received across all invoices, filterable and exportable, with the cheque photo or receipt slip attached.                                          | `GET /invoices/payments` (filters), `GET /invoices/payments/export` (CSV with Bank Date), `POST/GET/DELETE /invoices/payments/:paymentId/image`. verified: the payment DETAIL screen is broken by construction — `finance/payments/[id]/page.tsx` calls `useInvoicePayments({ limit: 200 })` and picks the row client-side, so any payment outside the newest 200 renders not-found (the B80 assertion), even though a working by-id path already exists and is unused (`GET /invoices/payments/:id` → `findPaymentById`, tenant-scoped). Downgraded from SHIPPED to PARTIAL — this is a one-line fix (swap to the existing hook), not missing plumbing.                 |
| INV-N12 | Retroactive price adjustment on an issued invoice                              | BROKEN 🔴  | Correct a wrong agreed price after the invoice went out, optionally across a range of past invoices, without re-issuing everything by hand.                                 | `POST /invoices/:id/price-adjustment` (OPERATOR-only). BROKEN: B57 (Critical) — leaves regulated excise computed from the OLD price; B74 (High) — never recomputes invoice status after changing the total.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| INV-N13 | Estimate to invoice conversion                                                 | PARTIAL 🟡 | Quote first, bill later — accept an estimate and turn it straight into an invoice without re-entering the lines.                                                            | `POST /estimates/:id/convert-to-invoice`; `convertToInvoice` is a separate direct `InvoiceItem` writer (has to independently call `applyMsrpSnapshots`). PARTIAL: bug register B15 — Convert to Invoice is offered on the web when it cannot succeed.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| INV-N14 | Invoice document defaults and presentation settings                            | SHIPPED ✅ | Set the tenant's default terms, standing notes/T&Cs, deposit policy, and whether struck-through original prices are shown — once, not per invoice.                          | `GET/PATCH /settings/invoice` exposing `defaultTerms`, `hideOriginalPrice`, `depositDefaultPercent`, `depositCollectAtOrder`; `TenantConfig.invoiceNotes`/`invoiceTerms`/branding fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| INV-N15 | MSRP / suggested retail printed on the invoice line                            | SHIPPED ✅ | Show the retailer what the item is meant to sell for on the shelf, alongside what they are being charged.                                                                   | `InvoiceItem.msrp`; `resolveMsrp` (customer override then product default); `applyMsrpSnapshots` called at every line-creating site; no-ops unless the tenant holds `flag.msrp` (MSRP addon). Rendered by the PDF and email templates.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| INV-N16 | Carrier shipment tracking carried on the invoice                               | SHIPPED ✅ | Record the carrier and tracking number on an invoice and filter the list by shipped state — the link between the bill and the parcel for a distributor who also ships.      | `PATCH /invoices/:id/shipment` → `updateInvoiceShipment`; `Invoice.shippingCarrier`/`shippingTrackingNumber`/`shippedAt` (copied from the order at generation, editable afterward on any non-VOID invoice); a dedicated `shipped` filter in `findAll`. missedCapability, added at verification (NICE).                                                                                                                                                                                                                                                                                                                                                                   |
| INV-N17 | Invoice register CSV export                                                    | PARTIAL 🟡 | Export the invoice list (not just the payments list) to CSV for offline reconciliation.                                                                                     | `apps/web/app/(dashboard)/invoices/page.tsx` `handleExport` pulls up to `EXPORT_LIMIT=1000` rows and writes a CSV client-side, toasting when the result was truncated. PARTIAL: silently capped at 1000 rows with no server-side full export. missedCapability, added at verification (NICE).                                                                                                                                                                                                                                                                                                                                                                            |
| INV-N18 | Scannable barcode per invoice line on the PDF                                  | SHIPPED ✅ | A receiving clerk can scan the printed bill against the goods, line by line.                                                                                                | `invoice-pdf.service.ts` renders a Code128 barcode per line from `invoiceItemCode(product)` (unitSku ?? barcode ?? sku) via bwip-js, embedded as a data URI. missedCapability, added at verification (NICE).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| INV-N19 | Live invoice updates pushed to open screens                                    | SHIPPED ✅ | Two operators (or an operator and a driver at the door) working the same customer see the same balance without a refresh.                                                   | `gateway.emitInvoiceUpdated(tenantId, {...})` fires on `recordPayment`, check-status DEPOSITED/CLEARED and BOUNCED. missedCapability, added at verification (NICE).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| INV-N20 | CUSTOMER-role self-serve invoices and statement outside the buyer portal       | PARTIAL 🟡 | A second, older self-serve surface — plain CUSTOMER-role JWT access to invoice list/detail and a "my statement" endpoint — distinct from the addon-gated `/buyer/*` portal. | `GET /invoices` and `GET /invoices/:id` are `@Roles(OPERATOR, CUSTOMER[, DRIVER])` with `redactUpsellForCustomer` applied; `GET /customers/me/statement`. PARTIAL: this path carries no addon story at all, unlike the buyer portal it overlaps with. missedCapability, added at verification (NICE).                                                                                                                                                                                                                                                                                                                                                                    |

### Testing criteria

#### INV-N1

- [ ] Jest (api) money invariant: `depositAmount === roundMoney(total * depositPercent / 100)` and is never persisted as a column. `Jest`
- [ ] Jest (api): a customer default auto-applies; an explicit caller-supplied percent always wins. `Jest`
- [ ] Jest (api): an invoice with no deposit default is byte-identical to one created before deposits existed. `Jest`
- [ ] Jest (api): a deposit due today is not flagged overdue; one due yesterday with insufficient payment is. `Jest`
- [ ] Playwright (web): an invoice with a deposit shows Deposit due/Remainder due rows; one without shows neither. `Playwright`

#### INV-N2

- [ ] Jest (api) money invariant: a credit reduces the invoice as one CREDIT_NOTE payment row and increments `amountUsed` by the same figure. `Jest`
- [ ] Jest (api) idempotency: re-sending an already-SENT invoice applies nothing further. `Jest`
- [ ] Jest (api): two credits totalling more than the balance clamp to the invoice balance exactly. `Jest`
- [ ] Jest (api): an expired credit is skipped by auto-apply but revived when a payment consuming it is restored. `Jest`
- [ ] Jest (api): a credit note belonging to a different customer is refused 4xx. `Jest`

#### INV-N3

- [ ] Jest (api) money invariant: applying an advance decrements `AdvancePayment.balance` by exactly the amount written. `Jest`
- [ ] Jest (api): voiding then deleting the same ADVANCE payment restores the balance once, not twice. `Jest`
- [ ] Jest (api): applying more advance than the balance holds is refused 4xx with no partial write. `Jest`
- [ ] Playwright (web): from an open invoice with an advance available, the operator can apply it and the balance drops — no such control exists today. `Playwright`

#### INV-N4

- [ ] Jest (api): RECORDED straight to CLEARED is refused; BOUNCED is terminal. `Jest`
- [ ] Jest (api) money invariant: after BOUNCED with a $35 NSF fee, subtotal/total each increase by exactly 35.00 and the total identity still holds. `Jest`
- [ ] Jest (api): a bounced cheque no longer counts toward paid/exposure anywhere. `Jest`
- [ ] Jest (api): DEPOSITED/CLEARED change no balance. `Jest`
- [ ] Jest (api): CLEARED with an explicit settlement date sets both `clearedAt` and `settledAt`; without one, `settledAt` is left alone. `Jest`

#### INV-N5

- [ ] Jest (api): a legacy payment with `settledAt` null reports on `paidAt`. `Jest`
- [ ] Jest (api): a payment with `settledAt` next month drops out of this month's cash-flow money-in. `Jest`
- [ ] Jest (api): P&L, AR aging, statements and time-to-get-paid stay keyed on their documented dates, not `settledAt`. `Jest`
- [ ] Jest (api): `updatePayment` distinguishes a missing `settledAt` key from an explicit null. `Jest`

#### INV-N6

- [ ] Jest (api): sending a reminder does not change status, `sentAt`, or fire `INVOICE_SENT`. `Jest`
- [ ] Jest (api): a reminder on a PAID or VOID invoice is rejected 4xx. `Jest`
- [ ] Jest (api): the reminder email's amount-due reflects total minus payments, not total. `Jest`
- [ ] Jest (api): either `notifyEvent(PAYMENT_REMINDER)` gets a real caller, or the toggle is removed from the settings matrix. `Jest`

#### INV-N7

- [ ] Jest (api): a MONTHLY template run on the 1st sets `nextRunAt` to the 1st of next month; a same-day re-run generates nothing. `Jest`
- [ ] Jest (api): a failed `create()` reflects a MISSED cycle an operator can see and re-run, not a silent skip. `Jest`
- [ ] Jest (api): a deactivated template generates nothing. `Jest`
- [ ] Jest (api): autoSend failure with no email leaves the invoice DRAFT, never a dishonest SENT. `Jest`
- [ ] Playwright (web): an edit screen exists for an existing template and calls the already-working `useUpdateRecurringInvoice`/PATCH endpoint. `Playwright`

#### INV-N8

- [ ] Jest (api) invariant: `closing === opening + invoices raised - (payments + credits applied)`, to the cent. `Jest`
- [ ] Jest (api): a customer with 150 open invoices reports the full outstanding total, not the first 100. `Jest`
- [ ] Jest (api): WRITTEN_OFF invoices are excluded from receivable at both boundaries. `Jest`
- [ ] Jest (api) tenant isolation: statements for another tenant's customer 404 and mint no presigned URL. `Jest`
- [ ] Manual: the presigned statement URL downloads without a JWT and expires. `manual`

#### INV-N9

- [ ] Jest (api) idempotency: a webhook redelivery after a crash between record and SETTLED flip records the payment exactly once. `Jest`
- [ ] Jest (api) money invariant: a $500 payment against 200/200/300 allocates 200/200/100 oldest-first. `Jest`
- [ ] Jest (api): money arriving for a CANCELLED/EXPIRED/REJECTED request is still recorded with a CRITICAL log, never discarded. `Jest`
- [ ] Jest (api): cancelOwn never settles if the underlying charge already completed. `Jest`
- [ ] Manual/mobile: a buyer on mobile can start a card payment — currently impossible. `manual`

#### INV-N10

- [ ] Jest (api): writing off DRAFT, PAID, VOID or already WRITTEN_OFF is rejected 4xx. `Jest`
- [ ] Jest (api): a written-off invoice is excluded from aging and appears in bad-debts with its reason. `Jest`
- [ ] Jest (api): a payment recorded after write-off does not move status off WRITTEN_OFF. `Jest`
- [ ] Jest (api): the sales-agent accrual row is not deleted on write-off. `Jest`

#### INV-N11

- [ ] Jest (api): grouped standalone payments sharing a `paymentGroupId` share one image object. `Jest`
- [ ] Jest (api) tenant isolation: export CSV and register both exclude other tenants' rows. `Jest`
- [ ] Playwright (web): opening a payment receipt by direct URL for a payment older than the most recent page resolves correctly (fix: use `GET /invoices/payments/:id` instead of the 200-row list). `Playwright`
- [ ] Jest (api): an upload above 10MB or non-image mimetype is rejected 4xx with no storage write. `Jest`

#### INV-N12

- [ ] Jest (api) money invariant: after an adjustment, total matches the standard identity with tax re-derived from the new line subtotals including regulated excise. `Jest`
- [ ] Jest (api): adjusting a fully paid invoice down recomputes status rather than leaving stale PAID with hidden credit. `Jest`
- [ ] Jest (api): an adjustment on VOID or WRITTEN_OFF is refused 4xx. `Jest`
- [ ] Jest (api): the whole adjustment (lines, totals, ledger, commission) commits or rolls back together. `Jest`

#### INV-N13

- [ ] Jest (api): converting an already-CONVERTED, DECLINED or VOID estimate is refused 4xx. `Jest`
- [ ] Jest (api) money invariant: the resulting invoice's totals equal the estimate's, to the cent. `Jest`
- [ ] Jest (api): the converted invoice carries the MSRP and regulated snapshots exactly as `create()` would. `Jest`
- [ ] Playwright (web): Convert to Invoice is disabled/hidden whenever the server would refuse it. `Playwright`

#### INV-N14

- [ ] Jest (api): `depositDefaultPercent` absent returns null while an explicit 0 returns 0. `Jest`
- [ ] Jest (api): `hideOriginalPrice` toggles the strikethrough on SPECIAL/DISCOUNTED/PROMO lines. `Jest`
- [ ] Jest (api): a new invoice with no explicit notes/terms inherits tenant defaults; an explicit DTO value always wins. `Jest`
- [ ] Jest (api) tenant isolation: settings PATCH in tenant A does not change tenant B's defaults. `Jest`

#### INV-N15

- [ ] Jest (api): with `flag.msrp` off, `applyMsrpSnapshots` issues no query and every `msrp` is null. `Jest`
- [ ] Jest (api): editing `Product.msrp` after issue does not change an already-issued invoice's rendered MSRP. `Jest`
- [ ] Jest (api): a null msrp renders blank, never $0.00, on both PDF and email including the reminder path. `Jest`

#### INV-N16

- [ ] Jest (api): setting shipment fields on a VOID invoice is refused; on any other non-VOID status it succeeds. `Jest`
- [ ] Jest (api): the `shipped` filter in `findAll` returns exactly invoices with `shippedAt` set. `Jest`
- [ ] Playwright (web): entering a tracking number and carrier persists and displays on the invoice detail. `Playwright`

#### INV-N17

- [ ] Playwright (web): exporting an invoice list over 1000 rows shows the truncation toast and downloads exactly 1000. `Playwright`
- [ ] Jest (api): a server-side full export (once built) matches the on-screen filtered count exactly. `Jest`

#### INV-N18

- [ ] Jest (api): the embedded barcode data URI decodes back to `invoiceItemCode(product)` for a known fixture line. `Jest`
- [ ] Manual: a phone scanner reads the printed PDF barcode correctly. `manual`

#### INV-N19

- [ ] Jest (api): `emitInvoiceUpdated` fires with the correct `tenantId` scope on `recordPayment` and both check-status terminal transitions. `Jest`
- [ ] Playwright (web): a second browser tab on the same invoice reflects a payment recorded in the first tab without reloading. `Playwright`

#### INV-N20

- [ ] Jest (api): a CUSTOMER-role token gets `redactUpsellForCustomer` applied on `findOne`. `Jest`
- [ ] Jest (api): `GET /customers/me/statement` returns only the caller's own customer statement. `Jest`
- [ ] Jest (api): document whether this path and the buyer portal are meant to converge or coexist, and gate accordingly. `Jest`

## Advanced / future (P2)

| ID      | Capability                                                              | Status     | What it does                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-A1  | Automated dunning ladder                                                | MISSING ⬜ | A configurable chase sequence that fires on its own, respects opt-outs, and stops the moment the invoice is paid.         | Only `POST /invoices/:id/send-reminder` (manual) exists. `PAYMENT_REMINDER` is permitted on all channels but has zero callers repo-wide. No schedule, cadence config, or reminder-history model.                                                                                                                                                                            |
| INV-A2  | ACH / bank debit as a first-class collection method                     | PARTIAL 🟡 | Offer the buyer bank debit and handle its multi-day settlement honestly.                                                  | The settle path already maps `us_bank_account` to `PaymentMethod.ACH` with `settledAt`, and `expireCheckout` avoids cancelling an in-flight ACH. But `createHostedCheckout` sets no `payment_method_types` — which methods appear is entirely the connected Stripe account's own dashboard setting, with no RouteFlow toggle, fee disclosure, or in-app "processing" state. |
| INV-A3  | Push to the accounting package (QuickBooks / Xero)                      | MISSING ⬜ | Invoices, payments and credit notes flow into the tenant's existing accounting system.                                    | No export or sync exists; the only QuickBooks code is an inbound stub that throws "upload a CSV instead." Mobile settings renders decorative Xero/QuickBooks rows wired to nothing, and marketing copy promises a push that does not exist.                                                                                                                                 |
| INV-A4  | Bank feed and automatic cash application                                | MISSING ⬜ | Import the bank statement, match deposits to invoices automatically, human review only for ambiguous ones.                | No bank-feed model or reader exists. The nearest analogue is the supplier-statement matcher on the AP side, with no AR twin.                                                                                                                                                                                                                                                |
| INV-A5  | Destination-based / multi-jurisdiction sales tax                        | MISSING ⬜ | Tax computed from where the goods are delivered rather than a single tenant-wide rate.                                    | Tax is one tenant-level percentage (`SystemConfig` `settings.taxRate`) plus `Customer.isTaxExempt`. No tax-rate table, address-based lookup, or nexus concept anywhere.                                                                                                                                                                                                     |
| INV-A6  | Multi-currency invoicing                                                | MISSING ⬜ | Bill in the customer's currency with a recorded FX rate.                                                                  | `TenantConfig.currency` and `Customer.currency` both exist and default to USD but are unread downstream; `stripe-payment-provider.ts` `toCents` throws on any non-USD currency; `Invoice` carries no currency or fxRate column. Two dormant currency columns exist, not one — a future implementer has a head start but the capability is still absent.                     |
| INV-A7  | Early-payment discount terms (e.g. 2/10 net 30)                         | MISSING ⬜ | Offer a discount for paying early and account for it correctly when taken.                                                | No discount-window field on `Invoice`, no rule recognizing a discount taken; the over-payment guard would treat an intentionally-short payment as leaving a real balance rather than a settled discount.                                                                                                                                                                    |
| INV-A8  | Installment plans / structured payment schedules                        | MISSING ⬜ | Split a large invoice into scheduled installments beyond the single deposit-plus-remainder shape.                         | Explicitly deferred in the schema comment: "Deliberately minimal deposit schedule (Tier 1) ... No InvoiceInstallment table in this phase." Deposit amount is derived at read time and AR aging is untouched by it.                                                                                                                                                          |
| INV-A9  | Card on file / auto-charge on due date                                  | MISSING ⬜ | Store the customer's payment method with consent and charge it automatically on the due date.                             | Every card payment is buyer-initiated through a one-shot hosted Checkout session. No SetupIntent, no saved payment method, no scheduled charge job.                                                                                                                                                                                                                         |
| INV-A10 | Consolidated / period billing (one invoice per customer per week/month) | MISSING ⬜ | Roll a week's deliveries into a single statement-style invoice instead of one bill per drop.                              | Invoicing is strictly per-order or per-manual-document. `invoiceGroupId` links only regulated split siblings of ONE order, not multiple orders. `Invoice.deliveryBatchId` is read as a guard in seven places but is never written by any code path — a dead schema column that would have carried this feature.                                                             |
| INV-A11 | Collections workflow — credit hold, promise-to-pay, escalation          | PARTIAL 🟡 | Turn aging into action: stop new orders for a customer over their limit, record a promise-to-pay, escalate.               | `assertWithinCreditLimit` exists and is wired into order edit and change-request approval, gated by `flag.credit_limits`. Order CREATE has no credit check at all. No credit-hold flag, no promise-to-pay model, no dispute state, no collections queue.                                                                                                                    |
| INV-A12 | Idempotent money endpoints                                              | PARTIAL 🟡 | Every endpoint that moves money accepts a client-supplied key so a retry or double-tap can never create a second payment. | `IdempotencyKey` exists and is used, but only on the delivery path (`completeStop`/`completeWithPayment`). `POST /invoices/:id/payments`, `/invoices/payments/record` and `/payment-requests/:id/approve` accept no key — a row lock and over-payment guard serialize but do not deduplicate.                                                                               |

### Testing criteria

#### INV-A1

- [ ] Jest (api): a configured ladder fires exactly one reminder per rung per invoice, no duplicate on a same-day re-run. `Jest`
- [ ] Jest (api): an invoice reaching PAID between rungs sends no further reminders. `Jest`
- [ ] Jest (api): an opted-out customer is skipped without consuming a message meter. `Jest`
- [ ] Jest (api): each reminder writes a durable "last chased on" record visible on the invoice. `Jest`

#### INV-A2

- [ ] Jest (api): an ACH PaymentIntent settles as method ACH with `settledAt` = event time; a card settles as CREDIT_CARD with `settledAt` null. `Jest`
- [ ] Jest (api): a session left "complete" with an in-flight ACH cannot be cancelled by `cancelOwn`. `Jest`
- [ ] Jest (api): a seller-visible setting controls whether ACH is offered — none exists today. `Jest`
- [ ] Manual: the buyer sees an explicit "processing, may take several days" state rather than an apparent failure. `manual`

#### INV-A3

- [ ] Jest (api) invariant: every issued invoice/payment/credit note/write-off in a period maps to exactly one accounting-side document, totals reconciling to reported revenue. `Jest`
- [ ] Jest (api): re-running the export for the same period creates no duplicates. `Jest`
- [ ] Jest (api): a VOID or WRITTEN_OFF invoice exports as a reversal, never a silent deletion. `Jest`
- [ ] Immediate: remove or gate the decorative mobile integration rows and the marketing claim until a real sync exists. `manual`

#### INV-A4

- [ ] Jest (api) invariant: applied deposit lines sum to the bank deposit total, with an explicit unapplied remainder never a silent gap. `Jest`
- [ ] Jest (api): an ambiguous deposit is queued for human review, never auto-applied. `Jest`
- [ ] Jest (api): re-importing the same bank file applies nothing twice. `Jest`
- [ ] Jest (api): auto-application writes through the one money path (`recordStandalonePayment`). `Jest`

#### INV-A5

- [ ] Jest (api): two invoices for customers in different jurisdictions carry different resolved tax rates. `Jest`
- [ ] Jest (api) invariant: tax is snapshotted at issue time, immune to later rate changes. `Jest`
- [ ] Jest (api): a tax-exempt customer owes $0 regardless of jurisdiction, with an exemption reference recorded. `Jest`
- [ ] Jest (api): an unconfigured jurisdiction fails loudly at creation rather than billing 0%. `Jest`

#### INV-A6

- [ ] Jest (api): an invoice stores its own currency and FX rate; statements total per currency, never mixed. `Jest`
- [ ] Jest (api) money invariant: a zero-decimal currency is never multiplied by 100. `Jest`
- [ ] Jest (api): a cross-currency payment is refused or records both amounts plus the applied rate. `Jest`
- [ ] Jest (api): AR aging and the finance dashboard never sum two currencies into one figure. `Jest`

#### INV-A7

- [ ] Jest (api): payment within the discount window settles the invoice at the discounted amount. `Jest`
- [ ] Jest (api): the same amount paid after the window leaves a real balance and PARTIAL status. `Jest`
- [ ] Jest (api) money invariant: the discount taken is recorded explicitly, never a silent write-off. `Jest`
- [ ] Jest (api): the discount deadline and amount print on the PDF and email. `Jest`

#### INV-A8

- [ ] Jest (api) money invariant: installment amounts sum to `invoice.total` exactly, final installment absorbing rounding. `Jest`
- [ ] Jest (api): a payment applies to the earliest unpaid installment first, each with its own state. `Jest`
- [ ] Jest (api): AR aging buckets each installment on its own due date. `Jest`
- [ ] Jest (api): voiding the invoice voids every unpaid installment and releases wallet money already applied. `Jest`

#### INV-A9

- [ ] Jest (api): a stored method requires a recorded consent artifact and is revocable, blocking further auto-charge once revoked. `Jest`
- [ ] Jest (api) idempotency: an auto-charge run twice for the same invoice/date produces one PaymentIntent and one payment row. `Jest`
- [ ] Jest (api): a declined auto-charge leaves the invoice untouched, records the failure, does not retry forever. `Jest`
- [ ] Jest (api): the buyer is notified before the charge; an already-settled invoice is skipped. `Jest`

#### INV-A10

- [ ] Jest (api) money invariant: a consolidated invoice's total equals the sum of constituent orders' billable totals, each `invoicedQty` incrementing exactly once. `Jest`
- [ ] Jest (api): an order already billed on an earlier consolidated invoice cannot be pulled into a second one. `Jest`
- [ ] Jest (api): voiding a consolidated invoice releases `invoicedQty` across every contributing order. `Jest`
- [ ] Jest (api): the PDF groups lines by delivery date/order reference for reconciliation. `Jest`

#### INV-A11

- [ ] Jest (api): creating a NEW order that puts a customer over their credit limit is rejected 4xx — currently only edits are guarded. `Jest`
- [ ] Jest (api): a customer on credit hold cannot have a new order confirmed regardless of exposure. `Jest`
- [ ] Jest (api): a recorded promise-to-pay suppresses the dunning ladder until its date. `Jest`
- [ ] Jest (api): an invoice marked disputed is excluded from chasing but still counts in aging. `Jest`

#### INV-A12

- [ ] Jest (api): two POSTs with the same idempotency key on `/invoices/:id/payments` create one payment row and return the same body. `Jest`
- [ ] Jest (api): the same key with a different payload is rejected 4xx rather than silently returning the first result. `Jest`
- [ ] Jest (api): a double-tap of Approve on a buyer cash request writes money once. `Jest`
- [ ] Jest (api): keys are scoped per tenant. `Jest`

## How this varies by tenant

| Variation                                                                        | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the tenant gets any AR reporting at all                                  | Plan flag `flag.reports` on every `/bookkeeping/reports/*` route. `GET /bookkeeping/finance-dashboard` (carrying `arAging`) is deliberately ungated — an unflagged tenant still sees aging on the dashboard but 403s on every dedicated report.                                                                                                                                                               |
| Whether customers can see and pay their own invoices at all                      | Sold as addon `BUYER_PORTAL` granting `addon.buyer_portal`, but **NOT CONFIGURABLE / NOT ENFORCED** — no `@RequirePlanFlag`/`@RequireAddon` exists anywhere in the buyer controllers or `apps/web/app/buyer`. Every tenant's customers can reach the buyer portal today regardless of the addon; the key exists only in the plan catalog and seed data. This is a paid feature with no gate, not a variation. |
| Whether card/ACH collection is available, and on whose money                     | Per-tenant Stripe Connect OAuth (`TenantStripeConnect`, `chargeableAccount(tenantId)`) — standard accounts, direct charges. Not connected means the buyer panel offers cash declaration only. Which methods appear inside Checkout is the connected account's own Stripe dashboard setting, not a RouteFlow setting.                                                                                          |
| Default payment terms                                                            | Three-level cascade: `Customer.defaultPaymentTerms` → `SystemConfig` `invoice.defaultTerms` → hardcoded "Net 30".                                                                                                                                                                                                                                                                                             |
| Deposit policy — percentage, collected at order placement                        | `SystemConfig` `invoice.depositDefaultPercent` + `invoice.depositCollectAtOrder`, overridden per customer by `Customer.defaultDepositPercent`, overridden again by an explicit request value. Null vs 0 are deliberately distinguishable (never configured vs. explicit opt-out).                                                                                                                             |
| Whether the customer sees the struck-through original price on discounted lines  | `SystemConfig` `invoice.hideOriginalPrice` — web document only.                                                                                                                                                                                                                                                                                                                                               |
| Sales tax rate, and who is exempt                                                | Tenant-wide `SystemConfig` `settings.taxRate` plus per-customer `Customer.isTaxExempt`/`taxExemptDocumentKeys`. Regulated excise varies separately per `TrackedCategory.taxType` behind the `REGULATED_ITEMS` addon.                                                                                                                                                                                          |
| Whether suggested retail (MSRP) prints on invoice lines                          | Addon `MSRP` granting `flag.msrp` — `applyMsrpSnapshots` no-ops entirely when off, writing null.                                                                                                                                                                                                                                                                                                              |
| Whether invoices accrue sales-agent commission                                   | Addon `SALES_AGENTS` granting `flag.sales_agents` — class-level guard on both commission controllers.                                                                                                                                                                                                                                                                                                         |
| Whether a customer's credit limit is actually enforced                           | Plan flag `flag.credit_limits` gates the check, not the CRUD — an unflagged tenant's stored `creditLimit` values persist but are inert. Also subject to the platform-wide `PLAN_FLAG_ENFORCEMENT` kill switch.                                                                                                                                                                                                |
| Invoice branding and standing document text                                      | `TenantConfig` — logo, color, business name, address/phone/website, `invoiceNotes`, `invoiceTerms`, timezone.                                                                                                                                                                                                                                                                                                 |
| Which mail server the invoice leaves from                                        | Per-tenant BYO SMTP with a platform Resend rescue; a rescued send discloses both the failure reason and the substituted From address.                                                                                                                                                                                                                                                                         |
| Invoice number format — prefix, padding, starting number, per-year vs continuous | **NOT CONFIGURABLE** — hardcoded `INV-<year>-` plus 4-digit padding. A tenant-configurable `NumberingSequence` model exists but its `reserveNext` is not wired into live minting, so a migrating tenant cannot continue their old series.                                                                                                                                                                     |
| Invoice currency                                                                 | **NOT CONFIGURABLE** in practice — `TenantConfig.currency` and `Customer.currency` both default to USD but `Invoice` has no currency column and the Stripe provider throws on anything but USD.                                                                                                                                                                                                               |
| AR aging bucket boundaries (current / 1-15 / 16-30 / 31-45 / 45+)                | **NOT CONFIGURABLE** — hardcoded in the finance dashboard reader, so a tenant on Net 45+ terms cannot align aging to their own credit policy. Only `reports/ar-aging-invoices` accepts an `?intervalDays` override.                                                                                                                                                                                           |
| Reminder / dunning cadence                                                       | **NOT CONFIGURABLE** — no cadence model, no schedule, no per-customer chase policy. The only lever is an operator manually clicking Send reminder, one invoice at a time.                                                                                                                                                                                                                                     |
| Which channels an invoice or reminder may go out on                              | `NotificationRule` matrix per (event × channel), but `INVOICE_SENT` is hard-restricted to EMAIL+PORTAL (rule G12) — WhatsApp/SMS cells render locked. `PAYMENT_REMINDER` is permitted on all customer channels but has no writer, so that toggle governs nothing.                                                                                                                                             |

## Gaps for a great UX

| Severity | Gap                                                                              | Impact                                                                                                                                                                                                                                                                                                                                                             | Suggested direction                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | Invoice numbers are minted from a cross-tenant scan and jam at 9999              | Two tenants share one number series — a new tenant's first invoice can be numbered INV-2026-0901 — and any tenant passing 9999 invoices in a year hits a string sort that stops advancing, producing repeated conflicts on a business-critical write.                                                                                                              | Route `generateInvoiceNumber` through `forTenant()`, widen padding or sort numerically, finish wiring `NumberingSequence.reserveNext`. Pin with a two-tenant spec.                                     |
| CRITICAL | Monthly recurring invoices re-fire every night                                   | A MONTHLY template generates a duplicate invoice — and a duplicate email — every day of the month; because the cycle is claimed before creation, a genuine failure is silently reported as a successful run.                                                                                                                                                       | Fix `calcNextRunAt` for MONTHLY; make a failed generation visible as a missed cycle with a re-run affordance.                                                                                          |
| CRITICAL | Retroactive price adjustment corrupts tax and leaves a stale status              | Regulated excise stays computed from the old price, and invoice status is never recomputed — a fully paid invoice adjusted down stays PAID with the customer's overpayment invisible; a regulated filing carries the wrong excise.                                                                                                                                 | Re-derive `taxAmount` (including category tax) and call `recomputeStatus` inside one transaction; add a money-invariant spec.                                                                          |
| CRITICAL | The reminder/send email misstates what is owed on a part-paid invoice            | `buildInvoiceEmail` takes only `total` with no paid/balance parameter, so a customer who already paid part of the bill is shown — and chased for — the full amount. (Note: the PDF does not share this defect; it correctly excludes VOID payments and matches the API's own balance calculation.)                                                                 | Thread `paidAmount`/`balanceDue` into `buildInvoiceEmail` for both the send and reminder paths. Assert rendered amount-due for a part-paid fixture.                                                    |
| HIGH     | There is no automated chasing at all                                             | Collections is entirely manual, one invoice at a time, from an operator who has to notice — for a distributor whose cash position is 30-day paper this is the difference between a working AR process and a memory game.                                                                                                                                           | Build a daily sweep that calls the orphaned `markOverdue()` and fires `PAYMENT_REMINDER` on a tenant-configurable ladder with send history and opt-out respect.                                        |
| HIGH     | Overdue is written non-deterministically and never backfilled for quiet invoices | `recomputeStatus` persists OVERDUE on every payment-related event, but an invoice that simply sits with no activity never gets swept — so the stored status silently falls behind the read-time derivation used in `findAll`, and any future consumer that trusts the stored value alone (an export, a report, an integration) will disagree with the list screen. | Schedule `markOverdue()` per tenant on a daily cron so quiet invoices are backfilled too, or explicitly document derivation as the only source of truth and stop persisting OVERDUE at all.            |
| HIGH     | No idempotency on the money-recording endpoints                                  | `POST /invoices/:id/payments` has a row lock and an over-payment guard but no dedupe — a double-tap at the door or a retried request over a flaky connection can record two legitimate-looking payments.                                                                                                                                                           | Accept an idempotency-key header on the payment endpoints, reusing the existing `checkIdempotencyKey`/`saveIdempotencyKey` helpers already used on the delivery path.                                  |
| HIGH     | Mobile buyers cannot pay, and web operators cannot apply a customer advance      | The buyer mobile app can only read invoices/payments/statements (no card or cash-declaration path exists), and `useApplyAdvanceToInvoice` on web has zero callers, so a customer's prepayment cannot be consumed from the invoice screen at all.                                                                                                                   | Mirror the web `MakePaymentPanel` on mobile (the API already exists), and wire the dead advance hook into the web invoice detail alongside the existing credit-note apply.                             |
| HIGH     | Statements and list views silently truncate or misorder                          | The customer statement drops unpaid invoices past a 100-invoice cap; the payments detail screen 404s on any payment outside the newest 200 fetched client-side even though a correct by-id endpoint already exists and is unused.                                                                                                                                  | Aggregate outstanding/overdue server-side rather than over a fetched page; swap the payment detail screen to the existing `GET /invoices/payments/:id` hook.                                           |
| HIGH     | Credit exposure is checked on order edit but not on order creation               | `assertWithinCreditLimit` is wired into order edit and the at-door change-request path, but a brand-new order that puts a customer far over their limit is written with no check at all — the guard reads as enforced while the most common entry point is open.                                                                                                   | Call the same `assertWithinCreditLimit` from `orders.service` `create()` with the projected total, inside the create transaction.                                                                      |
| HIGH     | Voiding is not guarded or claimed atomically                                     | `voidInvoice` has no status guard and no atomic claim, so a double-click double-releases `OrderItem.invoicedQty` — which then lets the same goods be billed twice; credit notes also outlive their source invoice's void.                                                                                                                                          | Make the void a conditional `updateMany(status != VOID)` claim inside the existing transaction so a second call is a no-op; extend credit-release coverage to notes issued against the voided invoice. |
| HIGH     | A paid buyer-portal addon has no enforcement                                     | `addon.buyer_portal` exists in the plan catalog and marketing but nothing in code gates it — every tenant's customers can already use the buyer portal whether or not the addon was purchased.                                                                                                                                                                     | Either add the `@RequireAddon` guard the plan catalog implies, or retire the addon SKU and make the portal a base-plan feature deliberately, rather than leaving billing and enforcement disagreeing.  |
| MEDIUM   | Deposits are invisible to receivables                                            | The deposit percentage prints and computes a derived amount, but `recomputeStatus` and AR aging are explicitly untouched by it — an overdue 50% deposit shows nowhere in aging, the dashboard, or any report.                                                                                                                                                      | Add a deposit-aware slice to the aging/dashboard readers, or at minimum a "deposit overdue" filter on the invoice list.                                                                                |
| MEDIUM   | Aging buckets and payment terms cannot be aligned                                | Buckets are hardcoded while terms are freely configurable Net-N — a tenant on Net 45 reads an aging table whose boundaries mean nothing to their own credit policy.                                                                                                                                                                                                | Derive bucket boundaries from the tenant's default terms, or expose them as an invoice setting.                                                                                                        |
| MEDIUM   | Dead integration surfaces promise accounting sync that does not exist            | The mobile settings screen and the marketing site both promise Xero/QuickBooks sync wired to nothing real; the only actual code is an inbound stub that throws "upload a CSV instead."                                                                                                                                                                             | Remove or explicitly label those rows as coming-soon now; build a real export keyed by an external reference so re-runs never duplicate.                                                               |

## Cross-domain handoffs

- **Orders and delivery → Invoicing**: an order reaching DELIVERED (or a driver completing a stop)
  triggers invoice creation via `changeStatus`/`completeStop`/`completeWithPayment` calling
  `createInvoiceFromOrder`/`reconcileOrderDraftInvoice`/`recordDeliveryPaymentInTx`. This handoff
  is fire-and-forget today (B105): a failure leaves a delivered, never-billed order.
- **Invoicing → Orders**: `recomputeOrderFromInvoices` rebuilds the linked order's items, shipping
  fee and totals from the sum of all non-void invoices; `resyncOrderInvoicesForEdit` and siblings
  keep a pre-delivery draft mirror in lockstep with order edits. Invariant that must always hold:
  sum of sibling invoice totals equals order total.
- **Inventory**: `OrderItem.invoicedQty` is the over-billing guard, incremented on invoice
  creation and released on void/delete. A void that runs twice releases it twice (B84) and the
  goods become re-billable.
- **Credit notes and returns**: credit notes are consumed as CREDIT_NOTE payment rows via
  `applyCreditInTx`/`autoApplyOldestCreditsInTx` and returned by `releaseInvoiceCreditsInTx` on
  void/cancel/delete; `returns.service.ts` mints a lump-sum credit note on refund. A credit must
  reduce the invoice AND leave the wallet — one or the other, never both, never neither.
- **Buyer portal**: `/buyer/invoices`, `/buyer/statement(s)` and the whole payments panel read
  this domain. `BuyerPaymentRequest` is deliberately a separate table so a pending declaration
  never moves invoice status; `InvoicePayment` rows are written only on operator approval or the
  signature-verified webhook, always through `recordStandalonePayment`.
- **Bookkeeping and P&L**: revenue and COGS source from invoiced sales on `paidAt`/`issueDate`,
  while cash-flow and payments-received use `settledAt ?? paidAt`. Changing status, `settledAt`,
  or the write-off flow moves reported profit.
- **Regulated / compliance ledger**: a regulated invoice line writes `RegulatedSalesLedger` rows
  atomically with the invoice; void/revert reverse them, but reversals book in the current period,
  never backdated. Price adjustments currently break this (B57).
- **Sales agents and commissions**: roughly 18 hooks call the commission sync from send, void,
  revert, reopen, write-off, every payment mutation, and check-status BOUNCED. Commission base
  excludes tax/shipping/NSF fees and counts only PAID payments — deliberately a different filter
  from `recomputeStatus`, which counts everything non-VOID.
- **Customers**: `defaultPaymentTerms`/`defaultDepositPercent`/`isTaxExempt`/`creditLimit`/
  `pricingTier` all steer invoice generation. `getStatementForOperator` is the authoritative
  balance derivation, and `assertWithinCreditLimit` deliberately reuses it — never fork it.
- **Messaging and email**: invoice send fires `INVOICE_SENT` (EMAIL + PORTAL only; G12 blocks
  WhatsApp/SMS). Delivery honesty comes from `EmailService.send` returning `{delivered}` rather
  than throwing, with a per-tenant SMTP-to-Resend rescue that must disclose the substituted From
  address.
- **Estimates**: `convert-to-invoice` is a second direct `InvoiceItem` writer outside the normal
  create path — every line-level concern (MSRP snapshot, regulated snapshot, boxed proration) has
  to be replicated there or it silently degrades.
- **Platform billing** (tenants paying RouteFlow) is a different domain — `RfInvoice`,
  `TenantSubscription`, `/billing/*` — orthogonal to Stripe Connect (buyers paying their seller).
  The two must never share a code path or a webhook signing secret.

## What we could not verify

- Static code reading only — no app was run, no test suite executed, no live tenant touched.
  Every SHIPPED claim is anchored to a route, file, symbol or Prisma model that was opened;
  anything that could not be found is marked MISSING or PARTIAL rather than asserted.
- BROKEN/PARTIAL statuses citing bug-register IDs (B11, B12, B13, B15, B44, B46, B57, B66, B74,
  B80, B84, B87, B89, B92, B97, B100, B102, B103, B105, B106, B110, B119, B131, B169) are taken
  from the bug register (187 entries, all still marked Open). The independent re-verification pass
  confirmed B100 (cross-tenant numbering), B102 (email missing paid/balance), and directly
  refuted B97 (the PDF payments query already excludes VOID and matches the API) and softened
  B92 (the edit endpoint and hook exist — only the screen is missing). The remaining bug-register
  citations were trusted without re-deriving.
- The full `invoices.service.ts` (~238KB) and the web invoice detail page were not read in full —
  only the signature list plus the roughly 15 methods most load-bearing for this domain.
  Capabilities may exist in the unread bodies that are understated here.
- "`markOverdue()` has no caller" and "`notifyEvent(PAYMENT_REMINDER)` has no caller" are grep
  results across `apps/` (including `scripts/`) only — an external scheduler hitting an HTTP
  route would not appear in this search, so treat both as high-confidence but not certain.
- Runtime behavior of the Stripe Connect path was not verified — test-mode keys are reportedly
  live on production per prior notes; the path was not exercised. ACH availability specifically
  depends on the connected account's own Stripe dashboard settings, which are invisible from this
  repo.
- Web and mobile UI claims are based on hook imports and call sites, not on rendering the pages.
  Where a control is said not to exist (advance-apply on web, mobile buyer card payment), that
  means no caller was found for the hook or endpoint — not that the screen was visually inspected.
- The buyer portal's own invoice rendering, the driver at-door payment screen, and the credit-note
  domain were not audited in depth — each is adjacent and could carry defects in this domain not
  yet surfaced.
- Line numbers cited throughout reflect the working tree at a specific commit and will drift with
  any subsequent edit.
