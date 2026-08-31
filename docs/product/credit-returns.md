# Estimates, Credit Notes & Returns

_The record chain around a sale — quote to invoice, delivery to return, return to credit — that
keeps money and stock each moving exactly once._

> **Note:** this domain's analysis needed heavy correction after verification (verdict:
> NEEDS_CORRECTION) — treat it as a good starting map, not a final audit, and give it a second
> human pass before acting on the gap list.

## The problem

A wholesale distributor spends half its week on the paperwork that happens around a sale rather
than the sale itself. Prices get quoted over WhatsApp and then forgotten, so nobody can prove what
was agreed when the customer disputes the invoice. Goods come back off the truck — refused at the
door, damaged in transit, short-dated, wrong SKU — and the driver writes it in a delivery book that
reaches the office days later, by which point the invoice has gone out and the stock count is
wrong. Giving money back is worse: a credit is scribbled on a sticky note, applied to the wrong
invoice or to none at all, and either the customer is short-changed or the same credit is spent
twice. The accounting package never sees any of it, so month-end is a reconciliation of the
spreadsheet against the delivery book against the bank.

## Why it matters to a tenant

One record chain — quote to invoice, delivery to return, return to credit, credit to the next
invoice — means the money can only move once and the stock can only move once. RouteFlow enforces
caps a paper process cannot: a credit note can never exceed the invoice it credits (invoice-total
plus per-line caps in `credit-notes.service.ts`), a return can never exceed what is still returnable
on the order (row-locked cumulative check in `returns.service.create`), and a credit consumed as an
invoice payment is simultaneously drawn down in the customer's wallet — never both. Received goods
write a `StockMovement` type `RETURN` at the current average cost, so the stock number and the
valuation move together instead of drifting. The practical payoff is that the operator stops
chasing "did we already credit this?" and the customer's statement shows the credit without a phone
call.

## Core use cases

1. **Quote a customer, then turn the accepted quote into a billable document.** An operator prices
   a basket at that customer's tier, sends it as an estimate, and when the customer says yes
   converts it without re-keying a line. Anchors: `POST /api/v1/estimates` and
   `/estimates/:id/{send,accept,decline,convert-to-invoice,void}`;
   `apps/api/src/estimates/estimates.service.ts`.
2. **Take goods back and decide whether they go on the shelf.** Goods refused, damaged or
   over-ordered on a delivered order are filed as a return, triaged, physically received, and
   either restocked with a costed inventory movement or not. Anchors: `POST /api/v1/returns` and
   `/returns/:id/{approve,reject,in-transit,receive,cancel}`; `StockMovement` type `RETURN` in
   `returns.service.receive()`.
3. **Give money back as controlled store credit that can only be spent once.** A credit note is
   issued against an invoice (or standalone), capped so total credits never exceed the invoice,
   then consumed as a `CREDIT_NOTE` `InvoicePayment` — manually, automatically at send time, or as
   a pre-selected intent on an order. Anchors: `POST /api/v1/credit-notes` and
   `/credit-notes/:id/{apply,unapply,void}`; `CreditNote.amountUsed`; `OrderCreditNote`.

## Must have (P0)

| ID      | Capability                                                                          | Status     | What it does                                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECR-M1  | Create a priced quote for a customer                                                | 🟡 PARTIAL | Builds an estimate from catalogue products or freeform lines, pricing each line at the customer's tier/override with box/piece entry.                                                           | `estimates.service.ts:27-142`; tax/discount only from client-supplied `dto.taxAmount`/`dto.discount`, so web-created estimates always store 0; Issue Date dropped client-side, no column.                                                                                                                                                                                                                                                                                                                                                                                                   |
| ECR-M2  | Quote lifecycle: send, accept, decline, void                                        | 🔴 BROKEN  | Moves DRAFT → SENT → ACCEPTED/DECLINED, or voids.                                                                                                                                               | `estimates.service.ts:193-217`; `send()`/`decline()` are bare updates with no status predicate — a CONVERTED estimate can be re-sent, re-accepted, and converted again (B70). Send delivers nothing (no email template, no PDF).                                                                                                                                                                                                                                                                                                                                                            |
| ECR-M3  | Convert an accepted quote into a billable document                                  | 🟡 PARTIAL | Accepting a quote produces an Invoice with identical lines, guarded against double-conversion.                                                                                                  | `estimates.service.ts:219-285`; concurrency correct (atomic ACCEPTED→CONVERTED claim). Creates an Invoice only — no Order, no stock decrement; every line written `taxRate: 0`; no back-reference between Estimate and Invoice; web `useConvertEstimateToInvoice` destructures a field the response doesn't have, sending users to `/invoices/undefined`.                                                                                                                                                                                                                                   |
| ECR-M4  | Issue a credit note against an invoice, capped so it can never over-credit          | 🟡 PARTIAL | Issues store credit, optionally sourced from an invoice, refusing anything past that invoice's value.                                                                                           | `credit-notes.service.ts:60-267`; cumulative and per-line caps are real and correct. verified: downgraded from SHIPPED — `create()` selects the source invoice with no `status` field (`:108-124`), so credit can be issued against a VOID, WRITTEN_OFF, or still-DRAFT invoice; `voidInvoice` never touches existing CreditNote rows pointing at it.                                                                                                                                                                                                                                       |
| ECR-M5  | Apply a credit note to an open invoice                                              | ✅ SHIPPED | Applies all or part of a credit to an unpaid invoice; invoice balance and credit wallet fall together, invoice status recomputes.                                                               | `credit-notes.service.ts:522-568` (`applyToInvoice`) delegating to `applyCreditInTx` (`:369-450`); roundMoney everywhere; single `InvoicePayment` method `CREDIT_NOTE`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ECR-M6  | Reverse a credit: un-apply from an invoice, or void an unused credit                | ✅ SHIPPED | Pulls back a wrongly-applied credit, or voids an unused one — only while untouched.                                                                                                             | `unapplyFromInvoice` / `restoreCreditFromPaymentInTx`; `voidCreditNote` (`:570-605`) refuses APPLIED or amountUsed > 0 via a race-free `updateMany`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ECR-M7  | File a return against a delivered order, with an over-return guard                  | 🟡 PARTIAL | Files a return of products/quantities from a delivered order, refusing more than still returnable.                                                                                              | `returns.service.ts:40-155`; row-locked `FOR UPDATE` plus in-payload accumulation is correct. Ceiling is `orderLine.qty` (ordered), not `deliveredQty` — a short-delivered order's full ordered qty can be returned (B53, Critical). Quota query filters only `status != REJECTED`, so a CANCELLED return permanently consumes quota (B82).                                                                                                                                                                                                                                                 |
| ECR-M8  | Return review workflow: approve, reject, mark in transit, receive                   | ✅ SHIPPED | A filed return is triaged before stock or money moves, each transition guarded and non-repeatable.                                                                                              | `returns.service.ts:206-306`; atomic claim on receive (`:244-250`) prevents double-restock; `apps/mobile/lib/returns-logic.ts` mirrors server predicates exactly.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ECR-M9  | Restock received goods into inventory with a costed movement                        | 🟡 PARTIAL | Goods physically received are added to on-hand stock with an auditable costed movement, or deliberately not restocked.                                                                          | `returns.service.receive() :252-286` writes `StockMovement` type `RETURN` at current averageCost. All-or-nothing boolean at receive time; web receive UI has no per-item toggle; driver return screen sends no restock key, defaulting damaged goods to restock:true (B61); `restock:false` writes nothing at all — no quarantine, no write-off.                                                                                                                                                                                                                                            |
| ECR-M10 | Resolve a received return into money back for the customer                          | 🟡 PARTIAL | A received return is refunded — as store credit valued from the original order lines, or recorded as refunded externally.                                                                       | `returns.service.processRefund :308-379`; boxed-safe per-unit math. Claim and credit mint are in SEPARATE transactions — a cap rejection or crash between them strands the return REFUNDED with `creditNoteId` null (B68). Cap is bypassed whenever the order has 0 or 2+ invoices (B53).                                                                                                                                                                                                                                                                                                   |
| ECR-M11 | Tenant isolation and role control across all three documents                        | 🔴 BROKEN  | No tenant should see or touch another tenant's quotes, credits or returns; customers/drivers reach only what their role allows.                                                                 | verified: downgraded from SHIPPED — module-level `forTenant()` discipline is real (estimates/credit-notes/returns services, security specs), BUT `DELETE /api/v1/settings/financial-data` (and `/tenant/settings/financial-data`) at `apps/api/src/system-config/settings.controller.ts:30,32,360-385` runs on the RAW `prisma.$transaction` client and executes `tx.invoicePayment.deleteMany({})` (`:364`) and `tx.creditNote.deleteMany({})` (`:370`) with no tenant predicate. Any OPERATOR token in any tenant destroys every tenant's store credit and every CREDIT_NOTE payment row. |
| ECR-M12 | Browse and search quotes, credits and returns                                       | 🟡 PARTIAL | Operators find documents by customer, status, date or free text and see what they're worth.                                                                                                     | Pages exist for all three, filters work server-side for estimates/credit-notes. Returns search box is fully inert — no bound param (B166); Returns "Total Return Value" KPI and every row render $0.00 (B75); credit-note list shows raw invoice UUID (B19); Estimates "Expired" filter throws (no EXPIRED status, B16).                                                                                                                                                                                                                                                                    |
| ECR-M13 | Cross-tenant financial wipe endpoint destroys credit notes and credit-note payments | 🔴 BROKEN  | `DELETE /settings/financial-data` (and the `tenant/settings` alias) is meant to reset a single tenant's finance data but wipes all tenants' `CreditNote` and `InvoicePayment` rows tenant-wide. | `apps/api/src/system-config/settings.controller.ts:30,32,360-385` — `@Roles(OPERATOR)` class-wide, uses raw `this.prisma.$transaction` (bypasses `forTenant()`), `tx.creditNote.deleteMany({})` and `tx.invoicePayment.deleteMany({})` with an empty where clause. Breaks the `CreditNote.amountUsed` ↔ `InvoicePayment` invariant the whole domain depends on. Missed by the original analysis; added per verification.                                                                                                                                                                    |

### Testing criteria

#### ECR-M1

- [ ] Given a customer on pricingTier 2 and a product with a tier-2 price, a line with no
      unitPrice persists unitPrice == tier-2 price, priceType SPECIAL, originalPrice ==
      product.pricePerUnit. `Jest (api)`
- [ ] Given unitsPerBox 12 and a line {boxes:2, pieces:3}, EstimateItem.qty == 27 and subtotal !=
      qty * unitPrice (must use computeLineSubtotal). `Jest (api)`
- [ ] estimate.total == roundMoney(sum of line subtotals - discount + taxAmount) to the cent; every
      persisted monetary column is 2dp. `Jest (api)`
- [ ] A customerId belonging to another tenant throws NotFoundException and writes no Estimate row.
      `Jest (api)`
- [ ] Creating an estimate for a tenant with non-zero settings.taxRate persists a non-zero
      taxAmount. Currently FAILS — pins the gap. `Playwright (web)`

#### ECR-M2

- [ ] POST /estimates/:id/send on a CONVERTED estimate is rejected 400 and status stays CONVERTED;
      same for /decline. Currently fails — the B70 pin. `Jest (api)`
- [ ] The laundering sequence convert → send → accept → convert leaves exactly one Invoice for that
      customer. `Jest (api)`
- [ ] send() dispatches through EmailService with the customer's address. `Jest (api)`
- [ ] Voiding a DRAFT estimate sets DECLINED (today's behaviour) — pin it so a future real VOID
      status is a deliberate, visible break. `Jest (api)`
- [ ] A customer actually receives something when an operator clicks Send. Today nothing leaves the
      building. `manual`

#### ECR-M3

- [ ] Converting a DRAFT or SENT estimate returns 400 and creates no Invoice. `Jest (api)`
- [ ] Two concurrent converts of the same ACCEPTED estimate yield exactly one Invoice. `Jest (api)`
- [ ] Invoice.total == estimate.total and sum of InvoiceItem.subtotal == Invoice.subtotal to the
      cent; boxed lines never re-derive qty * unitPrice. `Jest (api)`
- [ ] Converting for a taxable tenant produces a non-zero Invoice.taxAmount. Currently fails.
      `Jest (api)`
- [ ] A successful convert lands on a real invoice page, not `/invoices/undefined`. `Playwright (web)`

#### ECR-M4

- [ ] Invoice total 100.00 with an existing non-VOID credit of 60.00 — a second credit of 40.01 is
      400 and writes no row; 40.00 succeeds. `Jest (api)`
- [ ] A payload listing the same invoiceItemId twice must be merged before the per-line cap is
      checked. `Jest (api)`
- [ ] Credit line amounts that do not sum to dto.amount within 0.01 are rejected 400. `Jest (api)`
- [ ] An invoiceId from another tenant resolves to 400 'Invoice not found'. `Jest (api)`
- [ ] Creating a credit note against a VOID or DRAFT invoice is rejected 400 — verified gap, not yet
      enforced. `Jest (api)`

#### ECR-M5

- [ ] Credit with 50 remaining against an invoice balance of 30 writes an InvoicePayment of exactly
      30.00, leaves amountUsed 30, flips the invoice to PAID. `Jest (api)`
- [ ] After any application, sum of non-VOID InvoicePayment.amount <= invoice.total and
      CreditNote.amountUsed <= CreditNote.amount, both to the cent. `Jest (api)`
- [ ] Applying a credit whose customerId differs from the invoice's is 400 and writes nothing.
      `Jest (api)`
- [ ] Applying an expired credit is 400 even though its status is still ISSUED. `Jest (api)`
- [ ] Applying to a PAID/VOID/WRITTEN_OFF invoice is 400. `Jest (api)`

#### ECR-M6

- [ ] Un-applying restores the invoice's prior status and balance, deletes the CREDIT_NOTE payment,
      and returns amountUsed to its prior value. `Jest (api)`
- [ ] Voiding a credit with amountUsed > 0 returns 400 and leaves status unchanged. `Jest (api)`
- [ ] A concurrent apply and void of the same ISSUED credit cannot both succeed. `Jest (api)`
- [ ] Un-applying a credit whose expiresAt has passed revives it (expiry cleared). `Jest (api)`
- [ ] Voiding an unused credit that carried CreditNoteItem rows returns the regulated ledger to its
      pre-credit values. `Jest (api)`

#### ECR-M7

- [ ] Order line 10 already returned 4 — a return of 7 is 400 quoting the remaining figure; 6
      succeeds. `Jest (api)`
- [ ] One payload listing the same productId twice (6 + 6) against 10 ordered is rejected. `Jest (api)`
- [ ] A return against an order not in DELIVERED is 400. `Jest (api)`
- [ ] A CUSTOMER token filing against another customer's order gets 403; another tenant's token
      404s. `Jest (api)`
- [ ] Order line 10 with deliveredQty 4 — a return of 10 must be rejected. Currently passes on the
      ordered basis — the B53 pin. `Jest (api)`
- [ ] After cancel() fully reverses a return, the same quantity can be returned again. Currently
      fails (B82). `Jest (api)`

#### ECR-M8

- [ ] Table-drive every wrong-source transition (approve from APPROVED, in-transit from PENDING,
      receive from PENDING, receive from RECEIVED, refund from APPROVED) — each 400s. `Jest (api)`
- [ ] Two concurrent POST /returns/:id/receive produce exactly one StockMovement per restocked item
      and one ledger reversal; the loser 400s. `Jest (api)`
- [ ] A return id from another tenant 404s on every transition endpoint. `Jest (api)`
- [ ] returnActionFlags(status) matches the server guard for all eight ReturnStatus values.
      `Jest (mobile)`
- [ ] The return detail page makes the single available next action obvious. `manual`

#### ECR-M9

- [ ] Receiving qty 5 on a product at stock 20 leaves currentStock 25 AND exactly one StockMovement
      type RETURN with quantity 5, stockAfter 25. `Jest (api)`
- [ ] Receiving with {restock:false} writes zero StockMovements, leaves currentStock unchanged.
      `Jest (api)`
- [ ] A return received with restock:false then cancelled must not decrement stock. `Jest (api)`
- [ ] The RETURN movement's unitCost equals averageCost at receive time; avgCostAfter unchanged.
      `Jest (api)`
- [ ] A return whose items are reason DAMAGED must not restock by default. Currently fails (B61).
      `Jest (api)`

#### ECR-M10

- [ ] For a boxed line, refundAmount == sum of returnedQty * (line.subtotal / line.qty) rounded to
      cents — never qty * unitPrice. `Jest (api)`
- [ ] Two concurrent refunds of the same RECEIVED return mint exactly one CreditNote. `Jest (api)`
- [ ] Method EXTERNAL_REFUND flips status and persists refundAmount/refundedAt but creates zero
      CreditNote rows. `Jest (api)`
- [ ] When creditNotes.create throws on the cap, the return must not be left REFUNDED with a null
      credit. Currently fails (B68). `Jest (api)`
- [ ] A return on an order carrying two invoices is still capped against the combined non-VOID
      invoice total; today it mints uncapped (B53). `Jest (api)`
- [ ] Refunding a return not in RECEIVED is 400 and mints nothing. `Jest (api)`

#### ECR-M11

- [ ] A CUSTOMER token listing returns receives only rows matching their own Customer record.
      `Jest (api)`
- [ ] A CUSTOMER token cannot POST /credit-notes, /:id/apply, /:id/void or PATCH /:id (403).
      `Jest (api)`
- [ ] Every nested-created row has a non-null tenantId. `Jest (api)`
- [ ] A DRIVER token can POST and GET /returns but is refused GET /returns/:id, /approve, /receive
      and /refund (403). `Jest (api)`
- [ ] Fetching a return, estimate or credit note belonging to tenant B while authenticated as tenant
      A returns 404, never a leaking 403. `Jest (api)`

#### ECR-M12

- [ ] Typing a known return number into the Returns search narrows the list to that row. Currently
      fails (B166). `Playwright (web)`
- [ ] A tenant with at least one received return shows a non-zero 'Total Return Value'. Currently
      always $0.00 (B75). `Playwright (web)`
- [ ] GET /estimates?status=EXPIRED returns 400 or an empty page — never an unhandled 500 (B16).
      `Jest (api)`
- [ ] The credit-note list renders the source INV-YYYY-NNNN number, not a UUID (B19). `Playwright (web)`
- [ ] A fresh tenant with no estimates, credits or returns sees a named empty state with a primary
      action. `Playwright (web)`

#### ECR-M13

- [ ] `DELETE /settings/financial-data` scoped to tenant A must not touch tenant B's CreditNote or
      InvoicePayment rows — run the wipe with two seeded tenants and assert tenant B's rows survive.
      `Jest (api)`
- [ ] The endpoint uses `prisma.forTenant(tenantId)` (or an explicit `tenantId` where clause) instead
      of the raw client for every deleteMany in this transaction. `Jest (api)`
- [ ] After a legitimate single-tenant wipe, `CreditNote.amountUsed` and non-VOID
      `InvoicePayment.amount` stay reconciled tenant-wide (no orphaned references left on other
      tenants' invoices). `Jest (api)`

## Nice to have (P1)

| ID      | Capability                                                             | Status     | What it does                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECR-N1  | Convert an accepted quote into an ORDER, not straight to an invoice    | ⬜ MISSING | An accepted quote should become a picked, delivered, stock-decremented order like every other sale.              | `estimates.service.convertToInvoice` performs only `tx.invoice.create`; no convert-to-order route; `invoices.service.ts` has zero stock references.                                                                                                                                                                                                                                                                                                                                            |
| ECR-N2  | Edit or revise a quote after it is created                             | ⬜ MISSING | Correct a price, add a line, fix the date, or issue revision 2.                                                  | `estimates.controller.ts:14-58` exposes POST and GET only; no update hook on web; no issueDate/revision field on Estimate (B79).                                                                                                                                                                                                                                                                                                                                                               |
| ECR-N3  | Send the quote to the customer as an email or PDF                      | ⬜ MISSING | A branded, printable quote in front of the customer with a way to accept it.                                     | `send()` is a status flip only; no estimate template under `apps/api/src/email`; no pdf/print path on web (B17).                                                                                                                                                                                                                                                                                                                                                                               |
| ECR-N4  | Give the customer a credit-note document                               | ⬜ MISSING | An emailable, printable financial document the customer's bookkeeper needs.                                      | No pdf/print reference under `apps/web/app/(dashboard)/credit-notes`, no credit-note email template. understated: the customer already sees credit _balances_ via the buyer-portal wallet (see ECR-N9-adjacent evidence) — this item covers the document only, which is genuinely absent.                                                                                                                                                                                                      |
| ECR-N5  | Customer self-service return request                                   | ⬜ MISSING | A buyer starts a return from their own order/invoice and watches its status.                                     | API is built for it (`ReturnsController` admits CUSTOMER with ownership checks) but no buyer web UI and no mobile customer screen exist (B45).                                                                                                                                                                                                                                                                                                                                                 |
| ECR-N6  | Driver files the return at the doorstep                                | 🔴 BROKEN  | When a delivery is refused or short, the driver files the return for the goods NOT delivered.                    | `.../return/index.tsx:97` derives qty from `quantityDelivered` instead of the undelivered remainder — REFUSED items carry 0 and are rejected server-side; PARTIAL items file exactly the goods the customer kept (B128, Critical). Also attaches only to `stop.orders[0]`; sends no restock key; '+ Add' has no handler (B23).                                                                                                                                                                 |
| ECR-N7  | Per-item restock or write-off decision when receiving                  | 🟡 PARTIAL | A return of five where two are damaged should restock three and write off two, in one action.                    | `ReturnItem.restock` is per-item in schema and mobile's create screen sets it per product, but `receive()` applies one boolean to all items; web create modal has no restock control; web receive UI is all-or-nothing.                                                                                                                                                                                                                                                                        |
| ECR-N8  | Auto-apply the customer's oldest open credits when an invoice goes out | ✅ SHIPPED | A customer with store credit isn't asked to pay an invoice their credit already covers.                          | `autoApplyOldestCreditsInTx` (`credit-notes.service.ts:461-520`), oldest-first, idempotent, clamped to running invoice balance; called from InvoicesService's SENT flip.                                                                                                                                                                                                                                                                                                                       |
| ECR-N9  | Credit expiry (store-credit wallet)                                    | ✅ SHIPPED | Credits can carry a use-by date without ever clawing back money already applied.                                 | `CreditNote.expiresAt/appliedAt/autoApplied`; expiry is a computed filter, never a status flip, applied consistently at create/apply/restore. understated: web also has expiry validation UI at `credit-notes/page.tsx:183-188,484-488` — not server-only as the raw evidence implied.                                                                                                                                                                                                         |
| ECR-N10 | Select credits to apply at order time, before the invoice exists       | ✅ SHIPPED | An operator earmarks a customer's credits at order time so the resulting invoice arrives already reduced.        | `OrderCreditNote` intent table plus `validateSelectionsForCustomer`/`syncOrderCreditSelections`/`settleOrderCreditsInTx`; web `CreditNotePicker` with inline '+ New credit note'.                                                                                                                                                                                                                                                                                                              |
| ECR-N11 | Cancelling or voiding gives the credit back                            | ✅ SHIPPED | A credit consumed by a cancelled order or voided/deleted invoice returns to the customer's wallet.               | `releaseOrderCreditsInTx`/`releaseInvoiceCreditsInTx` over shared `releaseCreditsInTx`; `previewOrderCreditRelease` behind `GET /orders/:id/cancel-impact` shares the same function as the guard.                                                                                                                                                                                                                                                                                              |
| ECR-N12 | Photo evidence on a return                                             | ⬜ MISSING | A driver or operator photographs damaged goods for the credit decision and any supplier claim.                   | `Return.photoUrls` is a real column and `create()` persists it, but no client offers capture on web or mobile (B22).                                                                                                                                                                                                                                                                                                                                                                           |
| ECR-N13 | Cancel a return from the UI                                            | ⬜ MISSING | A return filed in error should be cancellable, reversing restock and ledger effects.                             | `POST /returns/:id/cancel` exists with full compensation logic but has no UI caller on web or mobile (B21). Compensation also reads status outside its own transaction — a concurrent receive() can leave it uncompensated (B69).                                                                                                                                                                                                                                                              |
| ECR-N14 | Credit one specific invoice line rather than a lump sum                | 🟡 PARTIAL | Crediting two cases of one product on a specific line so it attributes correctly to product, category and tax.   | verified: the web operator UI DOES send a per-line `items` array (`credit-notes/page.tsx:93,207-217`, `lib/api/credit-notes.ts:93`) — reachable, not "unreachable from any client" as first drafted. Real limitation: the server persists `CreditNoteItem` rows only for lines carrying a `trackedCategoryId` (`credit-notes.service.ts:247-251`), so a non-regulated line selection is validated and capped but the breakdown is discarded. Mobile create screen sends no items array at all. |
| ECR-N15 | Value and reason reporting on returns                                  | ⬜ MISSING | Know what returns cost: total value, top returned products, top reasons, which customers/drivers generate them.  | Returns list endpoint returns no monetary figure (B75); nothing under `apps/api/src/analytics` references returns or credit notes.                                                                                                                                                                                                                                                                                                                                                             |
| ECR-N16 | Edit a credit note (reason at any status, expiry while ISSUED)         | ✅ SHIPPED | Corrects a credit note's reason or extends/clears its expiry after creation.                                     | `PATCH /api/v1/credit-notes/:id` (`credit-notes.controller.ts:79-84`, OPERATOR-only) → `credit-notes.service.ts:1068-1090` — reason writable at any status, expiresAt only while ISSUED, ISO-validated; web `useUpdateCreditNote` with an inline reason editor on the detail page. Missed by the original analysis; added per verification.                                                                                                                                                    |
| ECR-N17 | Buyer-facing store-credit wallet (balance + active credits)            | ✅ SHIPPED | A customer sees their own available store credit and the list of active credit notes without calling the office. | `apps/api/src/buyer/statement.service.ts` (availableCredit, CREDIT_METHODS) → buyer portal finances and payments pages render a "Store Credit" KPI and an "Active Credits" list. Gated by the `buyer_portal` addon. Missed by the original analysis (reduced to "a statement line"); added per verification.                                                                                                                                                                                   |
| ECR-N18 | Mobile operator can create a credit note in the field                  | ✅ SHIPPED | An operator issues a credit note from the mobile app, not only from the web dashboard.                           | `apps/mobile/app/(operator)/credit-notes/new.tsx` — amount/reason/expiry, optional source invoice, POSTed to the same endpoint. Sends no `items` array, so a mobile-issued credit can never carry line attribution or reverse the regulated ledger per-line. Missed by the original analysis; added per verification.                                                                                                                                                                          |

### Testing criteria

#### ECR-N1

- [ ] POST /estimates/:id/convert-to-order on an ACCEPTED estimate creates a DRAFT Order with the
      same lines and decrements stock exactly as a hand-keyed order would. `Jest (api)`
- [ ] The stock effect of converting a quote equals that of creating the equivalent order directly.
      `Jest (api)`
- [ ] A quote converts once, to exactly one destination; the second attempt 400s. `Jest (api)`
- [ ] An operator quoting a route customer gets that quote onto a truck without re-keying the
      basket. `manual`

#### ECR-N2

- [ ] PATCH /estimates/:id on a DRAFT recomputes subtotal/total through computeLineSubtotal +
      roundMoney. `Jest (api)`
- [ ] PATCH on ACCEPTED or CONVERTED is 400. `Jest (api)`
- [ ] DELETE /estimates/:id succeeds only for DRAFT and cascades EstimateItem rows. `Jest (api)`
- [ ] A mistyped quantity on a DRAFT quote is corrected without burning a second estimate number.
      `Playwright (web)`

#### ECR-N3

- [ ] POST /estimates/:id/send calls EmailService with the customer's address; a customer holding
      the no-email sentinel is refused with a clear message. `Jest (api)`
- [ ] Send succeeds only from DRAFT (or re-send from SENT) and never from CONVERTED. `Jest (api)`
- [ ] The PDF renders descriptions, boxed quantities, per-line prices, expiry and letterhead, and
      its total matches Estimate.total to the cent. `manual`

#### ECR-N4

- [ ] GET /credit-notes/:id/pdf returns a document whose total equals CreditNote.amount and whose
      header cites the source invoice number. `Jest (api)`
- [ ] A customer token fetches only their own credit note's PDF. `Jest (api)`
- [ ] The document states remaining balance versus applied amount. `manual`

#### ECR-N5

- [ ] A buyer opens a delivered order, picks a line and reason, submits, and sees the return
      PENDING; another customer's return stays invisible. `Playwright (web)`
- [ ] A buyer-created return respects the same returnable ceiling and DELIVERED-order requirement
      as an operator-created one. `Jest (api)`
- [ ] A buyer can cancel their own PENDING return and cannot cancel a RECEIVED or REFUNDED one.
      `Playwright (web)`
- [ ] The buyer sees the credit note number once the return is refunded. `manual`

#### ECR-N6

- [ ] Order line 10 with a REFUSED mutation (0 delivered) derives return qty 10; PARTIAL with 4
      delivered derives 6. `Jest (mobile)`
- [ ] The derived quantity is zero-guarded before submit. `Jest (mobile)`
- [ ] DAMAGED / QUALITY_ISSUE / EXCESS_ORDER map to restock:false in the payload. `Jest (mobile)`
- [ ] At a stop with two orders, each returned line attaches to the order that actually contains
      it. `Jest (mobile)`
- [ ] Filing with no signal queues and submits once on reconnect, without duplicating. `manual`

#### ECR-N7

- [ ] POST /returns/:id/receive with a per-item plan restocks exactly the named items. `Jest (api)`
- [ ] The per-item plan is validated against the return's own items; an unknown productId is 400.
      `Jest (api)`
- [ ] cancel() after a partial receive reverses exactly the items that were restocked. `Jest (api)`
- [ ] The receive dialog shows one restock toggle per line, pre-seeded from each line's reason.
      `Playwright (web)`

#### ECR-N8

- [ ] Credits of 20 (older) and 50 (newer) against an invoice of 30 consume the full 20 then 10 of
      the 50. `Jest (api)`
- [ ] Sending the same invoice twice applies credit once. `Jest (api)`
- [ ] An expired credit is skipped while remaining ISSUED with amountUsed untouched. `Jest (api)`
- [ ] After auto-apply, sum of non-VOID payments <= invoice.total. `Jest (api)`

#### ECR-N9

- [ ] Creating a credit with expiresAt in the past is 400. `Jest (api)`
- [ ] A credit that expires while partially applied keeps its amountUsed and issued payments.
      `Jest (api)`
- [ ] Un-applying an expired credit clears the stale expiry. `Jest (api)`
- [ ] The open-credit list and auto-apply use the identical predicate. `Jest (api)`

#### ECR-N10

- [ ] An order with a 40 credit intent producing two split invoices applies against the base invoice
      first, then the sibling, never exceeding either balance. `Jest (api)`
- [ ] Re-running settle after an order-item edit shrinks or tops up existing payments rather than
      duplicating. `Jest (api)`
- [ ] A credit belonging to a different customer is rejected at selection time. `Jest (api)`
- [ ] The order modal shows "Credits to apply at invoicing -$X" as display-only. `Playwright (web)`

#### ECR-N11

- [ ] Cancelling an order that consumed a 30.00 credit returns amountUsed to 0, flips APPLIED→ISSUED,
      deletes the payment and removes the intent. `Jest (api)`
- [ ] An order with external cash payments refuses to cancel and leaves the order untouched.
      `Jest (api)`
- [ ] GET /orders/:id/cancel-impact lists exactly the credits the cancel would restore. `Jest (api)`
- [ ] Tenant-wide sum of CreditNote.amountUsed equals sum of non-VOID CREDIT_NOTE payments after any
      cancel/void/delete. `Jest (api)`

#### ECR-N12

- [ ] A return created with photoUrls persists them and findOne returns them. `Jest (api)`
- [ ] An operator attaches an image when filing a return and sees it on the detail page.
      `Playwright (web)`
- [ ] Capture works offline and uploads on reconnect with signed URLs that expire. `manual`

#### ECR-N13

- [ ] An operator cancels an APPROVED return through a confirmation step and the row moves to
      CANCELLED. `Playwright (web)`
- [ ] Cancelling a RECEIVED return decrements stock by exactly the restocked quantities and
      un-reverses the regulated ledger. `Jest (api)`
- [ ] If receive() commits between cancel()'s pre-read and its claim, compensation must still run.
      Currently fails (B69). `Jest (api)`
- [ ] Cancelling a REFUNDED return is 400. `Jest (api)`

#### ECR-N14

- [ ] An operator picks invoice lines and quantities on the web credit-note modal; the stored line
      breakdown for a REGULATED line sums to that line's amount within a cent. `Playwright (web)`
- [ ] Crediting a regulated line reverses that category's ledger entries proportionally; crediting a
      non-regulated line reverses nothing on the ledger (expected today). `Jest (api)`
- [ ] A non-regulated line selection is capped correctly server-side even though no CreditNoteItem
      row is persisted for it — pins the currently-silent data loss so a future fix is visible.
      `Jest (api)`
- [ ] A line credit is refused once that line's cumulative credits exceed its subtotal. `Jest (api)`

#### ECR-N15

- [ ] GET /returns returns a per-row value using the same formula as findOne. `Jest (api)`
- [ ] A returns-summary endpoint bucketed by reason returns figures that sum to the period's total
      return value. `Jest (api)`
- [ ] The 'Total Return Value' KPI equals the sum of the visible rows' values for the selected
      filter. `Playwright (web)`

#### ECR-N16

- [ ] PATCH /credit-notes/:id updates reason at any status. `Jest (api)`
- [ ] PATCH expiresAt is rejected unless status === ISSUED. `Jest (api)`
- [ ] A malformed or past expiresAt is rejected 400. `Jest (api)`
- [ ] The web detail page's inline reason editor persists and re-renders the updated reason.
      `Playwright (web)`

#### ECR-N17

- [ ] The buyer finances page "Store Credit" KPI equals statement.availableCredit. `Playwright (web)`
- [ ] "Active Credits" lists only CREDIT_NOTE transactions with runningBalance > 0.001. `Jest (api)`
- [ ] The wallet view is hidden when the buyer_portal addon is off for the tenant. `Playwright (web)`

#### ECR-N18

- [ ] A mobile operator creates a credit note with amount, reason, optional invoice and expiry, and
      it appears in the web credit-notes list. `manual`
- [ ] A mobile-issued credit with a source invoice still respects the invoice-total cap. `Jest (api)`
- [ ] A mobile-issued credit against a regulated invoice line reverses no per-line ledger entry
      (since no items array is sent) — pins the mobile/web behaviour split. `Jest (api)`

## Advanced / future (P2)

| ID      | Capability                                                           | Status     | What it does                                                                                                   | Evidence                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECR-A1  | RMA authorisation document and return label                          | ⬜ MISSING | A printable RMA the customer attaches to goods so the warehouse can match arriving cartons.                    | No RMA/label/barcode surface exists; return numbering (`RET-<last 6 digits of Date.now()>`) is collision-prone, not sequential.                                                              |
| ECR-A2  | Return-rate analytics and cost of returns                            | ⬜ MISSING | Return rate by product, customer, driver, route and reason, with cost and trend.                               | `analytics` has no returns/credit-note reference; bookkeeping surfaces only individual transaction rows.                                                                                     |
| ECR-A3  | Restocking fees and partial-credit policy                            | ⬜ MISSING | Credit 85% on a customer-refused delivery and 100% on a damaged one, automatically by reason code.             | `processRefund` credits 100% with no policy hook; no `restockingFee` field anywhere.                                                                                                         |
| ECR-A4  | Return eligibility windows and per-category rules                    | ⬜ MISSING | Refuse returns after N days from delivery; exclude regulated/perishable categories; per-customer exceptions.   | `create()` checks only DELIVERED status; no window/policy field; reason codes hardcoded.                                                                                                     |
| ECR-A5  | Quarantine location and write-off accounting for unsellable returns  | ⬜ MISSING | Goods received but not restocked land in a quarantine bin and book a shrinkage expense.                        | `restock:false` writes nothing — no movement, no expense; goods are physically present but invisible to stock/valuation/P&L.                                                                 |
| ECR-A6  | Return to vendor: chain a customer return to a supplier claim        | ⬜ MISSING | Goods damaged from the supplier raise a supplier claim and draw a SupplierCredit.                              | `SupplierCredit` exists only as the AP overpayment mirror; nothing links Return/ReturnItem to a VendorBill or supplier.                                                                      |
| ECR-A7  | Approval thresholds and segregation of duties on credits and refunds | ⬜ MISSING | Any credit/refund above a tenant-set amount needs a second person's approval; every issuance is attributed.    | `POST /credit-notes` and `/returns/:id/refund` are plain OPERATOR-role with no threshold; `CreditNote`/`Return` carry no issuer/approver id.                                                 |
| ECR-A8  | Quote expiry, templates and multi-option quotes                      | ⬜ MISSING | Quotes auto-expire, can be built from a saved template, and can offer priced options.                          | `Estimate.expiresAt` is stored but nothing reads it; `EstimateStatus` has no EXPIRED member (B16); no template or option structure.                                                          |
| ECR-A9  | Customer-facing accept link with e-signature                         | ⬜ MISSING | The customer clicks Accept in the emailed quote with a timestamped acceptance record.                          | `accept()` is operator-only with no token-authenticated public route; no acceptedAt/acceptedBy/signature field.                                                                              |
| ECR-A10 | Refund back to the original payment instrument                       | ⬜ MISSING | A card-paid customer gets the refund on the card, not only as store credit.                                    | `REFUND_METHODS` hardcoded to `CREDIT_NOTE`/`EXTERNAL_REFUND`; no wiring to Stripe Connect buyer payments.                                                                                   |
| ECR-A11 | Regulated-goods return compliance                                    | 🟡 PARTIAL | Returned excise/regulated goods reverse correctly for tax filing with a disposal attestation where unsellable. | Tax reversal is real (`reverseReturnEntries`, idempotent, symmetric on cancel). Missing: no destruction/disposal record or attestation, and `restock:false` leaves no evidence trail at all. |
| ECR-A12 | Quote pipeline and win-rate reporting                                | ⬜ MISSING | How much is out in quotes, conversion rate, time-to-accept, and rep/customer breakdowns.                       | No aggregate over Estimate exists; would also be unreliable today given the B70 status-laundering hole and universally-zero tax.                                                             |

### Testing criteria

#### ECR-A1

- [ ] Return numbers are strictly increasing per tenant per year; a burst of concurrent creates
      never collides. `Jest (api)`
- [ ] GET /returns/:id/rma renders only for APPROVED or IN_TRANSIT and carries a scannable number.
      `Jest (api)`
- [ ] Scanning the RMA barcode at goods-in opens the correct return's receive screen. `manual`

#### ECR-A2

- [ ] Return rate for a period == returned value / delivered value, tenant-scoped. `Jest (api)`
- [ ] Reason-code percentages sum to 100 within 0.01. `Jest (api)`
- [ ] Drilling from a reason bar lists exactly the returns that produced the figure. `Playwright (web)`

#### ECR-A3

- [ ] With a 15% fee for CUSTOMER_REFUSED, a return valued at 100.00 mints a credit of exactly 85.00.
      `Jest (api)`
- [ ] credit + fee == the pro-rated return value to the cent. `Jest (api)`
- [ ] With no policy configured, behaviour is byte-identical to today's 100% credit. `Jest (api)`

#### ECR-A4

- [ ] With a 14-day window, a return filed on day 15 is 400 quoting the window; day 14 succeeds.
      `Jest (api)`
- [ ] A product in a no-returns category is rejected while other lines are accepted (policy pinned
      either way). `Jest (api)`
- [ ] An operator override permission may file outside the window, recorded on the return. `Jest (api)`

#### ECR-A5

- [ ] Receiving with restock:false writes a quarantine or WRITE_OFF movement so movements still
      reconcile to the physical count. `Jest (api)`
- [ ] The write-off books an expense of qty * averageCost at receive time, in that period's P&L.
      `Jest (api)`
- [ ] Quarantined stock is excluded from sellable on-hand and valuation but reported in its own
      total. `Jest (api)`

#### ECR-A6

- [ ] Raising an RTV from a received return creates a claim referencing the originating
      VendorBillItem and moves the quarantined stock out. `Jest (api)`
- [ ] Settling the claim mints a SupplierCredit equal to the claimed cost basis. `Jest (api)`
- [ ] A return with no traceable purchase lot cannot raise an RTV and explains why. `Jest (api)`

#### ECR-A7

- [ ] A credit above the configured threshold is created PENDING_APPROVAL and cannot be applied
      until approved by a different user. `Jest (api)`
- [ ] The approver cannot be the issuer (403). `Jest (api)`
- [ ] Every credit note and refund records the acting user. `Jest (api)`
- [ ] With no threshold configured, behaviour is unchanged. `Jest (api)`

#### ECR-A8

- [ ] A scheduled job flips SENT estimates past expiresAt to EXPIRED, never touches
      ACCEPTED/CONVERTED, idempotent on re-run. `Jest (api)`
- [ ] An EXPIRED estimate cannot be accepted or converted but can be reopened by extending
      expiresAt. `Jest (api)`
- [ ] GET /estimates?status=EXPIRED returns those rows instead of erroring. `Jest (api)`

#### ECR-A9

- [ ] A single-use signed accept token flips DRAFT/SENT to ACCEPTED, records acceptedAt/acceptor,
      rejected on reuse or after expiry. `Jest (api)`
- [ ] The token is scoped to one estimate and one tenant. `Jest (api)`
- [ ] The acceptance trail is sufficient to settle a later price dispute. `manual`

#### ECR-A10

- [ ] Refunding a card-paid invoice's return issues a provider refund for the pro-rated amount and
      records the provider refund id. `Jest (api)`
- [ ] A retried refund reuses the same idempotency key. `Jest (api)`
- [ ] A provider failure leaves the return RECEIVED and retryable, never REFUNDED with nothing sent.
      `Jest (api)`
- [ ] A partial refund cannot exceed what was actually collected on that instrument. `Jest (api)`

#### ECR-A11

- [ ] Receiving a return of a regulated line reduces that category's period filing by exactly the
      pro-rated quantity and value, never negative. `Jest (api)`
- [ ] The reversal is idempotent per return. `Jest (api)`
- [ ] Cancelling a received return restores the filing to its pre-receive figures exactly. `Jest (api)`
- [ ] A regulated return marked unsellable produces a dated disposal record naming quantity,
      category and disposing user. No such record exists today. `manual`

#### ECR-A12

- [ ] Win rate == CONVERTED / (CONVERTED + DECLINED + EXPIRED) for the window, tenant-scoped.
      `Jest (api)`
- [ ] A CONVERTED estimate counts exactly once regardless of how many status flips it received.
      `Jest (api)`
- [ ] The dashboard pipeline figure matches the sum of the estimates list filtered to open statuses.
      `Playwright (web)`

## How this varies by tenant

| Variation                                                     | Mechanism                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the tenant has returns at all                         | `flag.returns` on `ReturnsController`, but it sits in `DARK_PLAN_FLAGS` and is muted unless `PLAN_FLAG_ENFORCEMENT=on` (defaults off) — **NOT effectively configurable today**. |
| Whether the tenant has estimates or credit notes              | **NOT CONFIGURABLE** — neither appears in `FLAG_KEYS`; every tenant on every plan gets both.                                                                                    |
| Sales tax on a quote/converted invoice                        | **NOT CONFIGURABLE** — read purely from client-supplied `dto.taxAmount`; converted invoice lines always write `taxRate: 0`.                                                     |
| Which reasons a customer may give for a return                | **NOT CONFIGURABLE** — hardcoded `VALID_RETURN_REASONS`, duplicated in a second hardcoded label map on the driver screen.                                                       |
| How a refund is given back                                    | **NOT CONFIGURABLE** — hardcoded `REFUND_METHODS = [CREDIT_NOTE, EXTERNAL_REFUND]`.                                                                                             |
| Whether returned goods go back on the shelf by default        | **NOT CONFIGURABLE** — hardcoded `restock: i.restock ?? true`.                                                                                                                  |
| How long store credit stays valid                             | Per credit note only (`CreditNote.expiresAt`, caller-supplied); no tenant-level default policy.                                                                                 |
| Whether returned regulated goods reverse the excise filing    | Data-driven — only lines resolving to a `TrackedCategory` reverse; the regulated programme is gated by `addon.regulated_items`.                                                 |
| Whether a credit note shrinks a sales agent's commission      | `flag.sales_agents` / `SALES_AGENTS` addon — `applyCreditInTx` calls the commission engine, which no-ops when the flag is off.                                                  |
| Whether the customer can see their credit notes/wallet at all | `addon.buyer_portal` — gates the buyer statement's credit-note fold-in and the finances/payments wallet views.                                                                  |
| Document numbering formats                                    | **NOT CONFIGURABLE** — `EST-YYYY-NNNN`, `CN-YYYY-NNNN`, and a non-sequential `RET-YYYY-<epoch-ms suffix>` are all hardcoded.                                                    |

## Gaps for a great UX

| Severity | Gap                                                                                                                                       | Impact                                                                                                                                                                                                                                         | Suggested direction                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Returns validated/restocked/refunded against ORDERED quantity, never deliveredQty; refund cap skipped when the order has 0 or 2+ invoices | A short-delivered order can be returned and refunded in full, restocking inventory that never left; a split-invoice order can be credited uncapped — real cash leaving the business the system believes it performed correctly                 | Cap create() at min(orderLine.qty, orderLine.deliveredQty); compute refundAmount from the actual invoiced line; select only non-VOID invoices and cap against their combined total (B53)                    |
| CRITICAL | Driver's doorstep return files the DELIVERED quantity instead of the undelivered one                                                      | A refused delivery (0 delivered) is rejected outright; a short delivery credits the goods the customer kept, not the goods lost                                                                                                                | Derive return qty as orderedQty − quantityDelivered for rendered rows, preview and POST body; guard against zero; attach lines to the correct order (B128)                                                  |
| CRITICAL | Refund claim and credit-note mint run in separate transactions with nothing linking them                                                  | A cap rejection or crash between them permanently strands a REFUNDED return with `creditNoteId` null and no recovery path — money owed the system believes was already given                                                                   | Wrap the claim and creditNotes.create in one transaction, or revert the return to RECEIVED on create() failure; add a data-integrity check for REFUNDED returns with null creditNoteId (B68)                |
| CRITICAL | Cross-tenant financial wipe endpoint deletes every tenant's credit notes and credit payments                                              | Any OPERATOR token in any tenant can silently destroy every other tenant's store credit and break the amountUsed/InvoicePayment invariant platform-wide                                                                                        | Scope every deleteMany in `DELETE /settings/financial-data` through `forTenant()` or an explicit tenantId predicate (verified finding, ECR-M13)                                                             |
| CRITICAL | Converting a quote produces an untaxed invoice with no order, no fulfilment, no inventory movement, and no back-reference                 | Taxable tenants under-bill every converted quote; goods are billed but never picked/delivered/decremented; a CONVERTED estimate can't be navigated to the invoice it became                                                                    | Resolve tax server-side from tenant settings; make convert-to-ORDER the primary path; add Estimate.invoiceId / Invoice.estimateId inside the conversion transaction (B17, B79)                              |
| HIGH     | Damaged/expired/quality-failed goods restock into sellable inventory by default; non-restocked goods vanish from every record             | Unsellable stock is counted sellable and can be picked for the next order; goods physically in the warehouse are invisible to stock, valuation and P&L                                                                                         | Apply a reason-to-restock policy at capture; per-item receive toggle seeded from reason; restock:false writes a quarantine/write-off movement and expense (B61)                                             |
| HIGH     | A CONVERTED estimate can be laundered back to ACCEPTED and converted a second time                                                        | Customer billed twice for one quote; only found by a human reading the invoice list                                                                                                                                                            | Add the CONVERTED guard to send() and decline() as an atomic updateMany, matching accept()/convertToInvoice()/voidEstimate() (B70)                                                                          |
| HIGH     | Quotes cannot be edited, re-dated, or actually sent to anyone                                                                             | A typo means abandoning the number; Issue Date has no column; Send only flips a status with nothing delivered                                                                                                                                  | Add PATCH/DELETE for DRAFT estimates, an issueDate column, and a real send path mirroring the invoice email/PDF template (B79, B17)                                                                         |
| HIGH     | Cancelling a return permanently burns the order's returnable quota                                                                        | An operator who cancels a mistyped return can never re-file it correctly                                                                                                                                                                       | Change the quota filter to `status notIn ['REJECTED','CANCELLED']` (B82)                                                                                                                                    |
| HIGH     | Returns list shows $0.00 value for every row/tenant; search box does nothing                                                              | A headline finance number is unconditionally wrong; hundreds of returns can't be found by number/order/customer                                                                                                                                | Expose the server-computed per-return value reusing findOne's formula; thread a search param through the controller and services (B75, B166)                                                                |
| HIGH     | Credit notes survive their source invoice being voided, and can still be issued against a VOID/DRAFT invoice                              | The sale is reversed but the customer keeps spendable credit; fresh credit can be minted against a dead invoice's frozen total                                                                                                                 | Refuse create() sourced from a VOID/DRAFT invoice; have voidInvoiceInTx void or cap unused CreditNotes referencing it (B66)                                                                                 |
| HIGH     | No user attribution and no approval control anywhere in the domain                                                                        | Any OPERATOR can issue unlimited credit and refund any return; nobody can later answer "who credited this customer"                                                                                                                            | Stamp the acting user on credit-note creation, return approval and refund; optional tenant threshold requiring a second approver                                                                            |
| MEDIUM   | Customers cannot start or track a return; operators cannot cancel one either, though both endpoints exist                                 | Every return costs an operator a phone call; the cancel endpoint has no caller on either surface                                                                                                                                               | Build a minimal buyer-side return flow reusing existing endpoints; wire the existing cancel endpoint into both operator surfaces (B45, B21)                                                                 |
| MEDIUM   | cancel() decides compensation from a status read taken outside its own transaction                                                        | A concurrent receive() between the pre-read and the claim can leave stock and the regulated ledger silently uncompensated                                                                                                                      | Re-read status inside the transaction after the claim, or capture the pre-image with UPDATE ... RETURNING (B69)                                                                                             |
| MEDIUM   | Non-regulated line-level credits are validated and capped but never persisted as CreditNoteItem rows                                      | The per-line attribution the web UI already collects is silently discarded for the common (non-regulated) case                                                                                                                                 | Persist CreditNoteItem rows for every selected line, not only those carrying a trackedCategoryId (verified finding on ECR-N14)                                                                              |
| MEDIUM   | Dead and misleading controls scattered across all three surfaces                                                                          | Corrosive to trust: dead Convert-to-Invoice button, throwing Expired filter, unreachable Draft/Issue credit-note UI, raw UUIDs in the credit-note list, driver '+ Add' with no handler, dropped condition/notes text, unused photoUrls capture | Sweep together: gate Convert on ACCEPTED, fix the convert response destructure, delete dead UI, join invoiceNumber into the list, add or remove the inputs consistently (B15, B16, B18, B19, B20, B22, B23) |
| LOW      | Return numbers are not sequential and can collide                                                                                         | `RET-<last 6 digits of Date.now()>` repeats roughly every 16m40s against a unique constraint, surfacing as a raw 500                                                                                                                           | Replace with a per-tenant per-year sequence allocated inside the same transaction, matching EST-/CN-/INV-                                                                                                   |

## Cross-domain handoffs

- **Orders → Returns**: a return can only be filed against an Order in DELIVERED, validated against
  `Order.lineItems`. `deliveredQty` is the handoff that must not break — routes' delivered-basis
  billing writes it and returns currently ignore it. Order deletion refuses while any return is
  attached, including CANCELLED ones.
- **Returns → Inventory**: `receive()` writes `StockMovement` type `RETURN` with `unitCost`/
  `avgCostAfter` set to the product's current averageCost and increments `Product.currentStock`;
  `cancel()` decrements and deletes those movements symmetrically by the `RET-<id8>` reference.
- **Returns → Credit Notes**: `processRefund` calls `CreditNotesService.create` sequentially and
  links via `Return.creditNoteId`. The credit is deliberately a lump sum with no line items because
  the regulated ledger was already reversed at receive() — line linkage here would double-reverse.
- **Credit Notes → Invoices**: a credit is consumed as an `InvoicePayment` method `CREDIT_NOTE` and
  simultaneously drawn down via `CreditNote.amountUsed` — never both. `deletePayment`/`voidPayment`
  refuse `CREDIT_NOTE` rows and point at unapply instead, keeping the wallet and invoice ledger from
  diverging.
- **Credit Notes → Orders**: `OrderCreditNote` intents are settled by `settleOrderCreditsInTx`
  whenever the order's invoice picture changes. Order cancel/delete and invoice void/delete must
  call `releaseOrderCreditsInTx`/`releaseInvoiceCreditsInTx` or the credit is consumed forever.
- **Estimates → Invoices**: `convertToInvoice` mints an Invoice inside its own transaction, bypassing
  `InvoicesService` entirely — none of that service's tax folding, shipping-fee seeding,
  category-tax handling, MSRP snapshotting or order reconciliation applies. Any invoice rule added
  to `InvoicesService` silently does not apply to converted quotes.
- **Returns/Credit Notes → Regulated ledger**: `receive()`/`cancel()` call `reverseReturnEntries`/
  `unreverseReturnEntries` (pro-rated, idempotent); credit notes call `reverseCreditNoteEntries` for
  lines carrying a `trackedCategoryId`, with `unreverseCreditNoteEntries` on void.
- **Credit Notes → Sales agents/commissions**: `applyCreditInTx` calls
  `commissionEngine.syncInvoiceCommissionSafe` on every application, since a credit shrinks the
  commission base.
- **Credit Notes → Bookkeeping and buyer statements**: credit notes appear as `CREDIT_NOTE`
  transaction rows in bookkeeping and as statement lines / a wallet balance for the customer.
  Returns appear in neither — no return line on a customer statement, no return figure in any
  report.
- **Returns/Credit Notes → Financial-data wipe**: `DELETE /settings/financial-data` deletes
  `CreditNote` and `InvoicePayment` rows with no tenant scoping — any change to either model's
  schema or invariants must account for this endpoint bypassing `forTenant()`.
- **Returns/Credit Notes → Notifications**: return creation emits `emitReturnCreated` and
  credit-note creation emits `emitCreditNoteCreated` for live operator dashboards. Nothing notifies
  the customer of either event directly (the buyer portal wallet is pull, not push).

## What we could not verify

- Jest suites were read, not executed — what's asserted here is what the service code and named
  specs do, not that the suites currently pass. A cached turbo replay can print a stale log
  verbatim, so a green run would not have proven this either.
- `credit-notes.service.ts`'s order-credit primitives (`validateSelectionsForCustomer`,
  `syncOrderCreditSelections`, `settleOrderCreditsInTx`, `releaseCreditsInTx`,
  `unapplyFromInvoice`) were confirmed via doc comments, the code map and call sites rather than a
  full body read — the ECR-N10/N11 SHIPPED verdicts rest on secondary evidence.
- The web credit-notes and returns list pages were not read line by line beyond what verification
  spot-checked; dead-control claims (Draft/Issue UI, raw UUIDs, inert search, $0 value) come from
  the bug register's cited line numbers.
- Mobile operator screen bodies (beyond the shared pure-logic helpers and the credit-note create
  screen checked in verification) were not read in full — "mobile mirrors web" is largely a
  structural claim.
- `flag.returns` being effectively off (muted unless `PLAN_FLAG_ENFORCEMENT=on`) is read from source
  and an env default, not observed in a deployed environment.
- `apps/web/lib/api/estimates.ts:130-139` destructuring `{invoiceId}` from a convert response that
  only has `id`, sending the user to `/invoices/undefined`, was read on both sides but not run live.
- Verification's own corrections were not independently re-verified by a third pass; treat the
  financial-data-wipe finding (ECR-M13) and the ECR-M4/ECR-M11 downgrades as high-confidence but
  still worth a live-environment confirmation before treating them as fully settled.
