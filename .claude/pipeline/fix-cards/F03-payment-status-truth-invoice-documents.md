# F03 · Payment-status truth and invoice documents

**Bug IDs (9):** B11, B57, B74, B81, B84, B85, B97, B102, B103

**Root cause:** status: { not: "VOID" } used where status: "PAID" was meant, so unconfirmed DRAFT money is folded into balances, dashboards and the customer's own PDF — plus the invoice-totals writers that skip recomputeStatus.

**Ships as:** One PR.

**Files:** invoices.service.ts (findAll, applyPriceAdjustment, updatePayment, voidInvoiceInTx, createPartialFromOrder) · invoice-pdf.service.ts + invoice-pdf-template.tsx · email/email.service.ts · bookkeeping.service.ts

**Together because:** One predicate, one definition of "confirmed payment", and two document renderers that must move with it. B103 (promo strikethrough missing from PDF/email) is the same two renderers and would otherwise force a second pass over them.

**Guardrails / shared infra:** None new; consumes the not-VOID predicate fix everywhere it recurs.

**Dependencies / lane notes:** Must land before F07, F09, F16 (semantic — they call recomputeStatus and the confirmed-payment predicate this batch defines).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F03.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B11  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B57  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B74  | T1   | e5b0af8e       | MOVED (corrected)            |
| B81  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B84  | T1   | e5b0af8e       | OUT_OF_BOUNDS (corrected)    |
| B85  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B97  | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED          |
| B102 | T1   | 0cd59277       | MOVED (disambiguate in-file) |
| B103 | T1   | 0cd59277       | TOKEN_NOT_FOUND              |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B11 — Draft payments are invisible once recorded

**Area:** Invoices / payments · web

**Meant to do:** A payment saved as DRAFT (e.g. from a bulk bank-reconciliation entry) should stay invisible to money totals until an operator confirms it, with something surfacing that it's waiting.

**Actually does:** DRAFT `InvoicePayment` rows are correctly excluded from `getCashFlow`/`getPaymentsReceivedReport` (filter `status: PAID`), but `invoices.service.ts findAll`'s `balanceDue`, `recomputeStatus` inputs, and `bookkeeping.service.ts getMobileDashboard`/`getFinanceDashboard`/`getDashboard` all filter payments with `status !== VOID` — so a DRAFT payment's amount IS silently folded into 'totalCollected', 'outstanding receivables', and the invoice list's own balance-due number, even though `invoice.status` never advances (recordPayment/recordStandalonePayment only update invoice status when `status === 'PAID'`). No UI anywhere flags a DRAFT payment: the invoice detail page's Payment History row renders it with the identical green 'confirmed' checkmark as a real PAID payment (only VOID gets different styling); only the separate `finance/payments` list page has a Draft badge/filter.

**The gap:** Claim's premise ("counts toward no total") is half-wrong: cash-flow/Payments-Received correctly exclude DRAFT, but several OTHER money surfaces (invoice-list balance, mobile & finance dashboards) silently INCLUDE it — the opposite failure, and worse (status vs. balance now disagree). No-badge part is accurate for dashboard/invoice pages.

**Evidence:** apps/api/prisma/schema.prisma:144-148 (PaymentStatus DRAFT/PAID/VOID); apps/web/components/CustomerRecordPaymentModal.tsx:129,157-158,394,410 (bulk allocation + Save-as-Draft); apps/api/src/invoices/invoices.service.ts:4811-4901 recordStandalonePayment (status-update block gated `if (status === "PAID")` at 4883); apps/api/src/invoices/invoices.service.ts:2862-2869 findAll balanceDue via `p.status !== "VOID"` (includes DRAFT); apps/api/src/bookkeeping/bookkeeping.service.ts:1097-1101,1119-1132 getMobileDashboard (includes DRAFT); apps/api/src/bookkeeping/bookkeeping.service.ts:991-996 getCashFlow (correctly PAID-only); apps/api/src/bookkeeping/bookkeeping.service.ts:1604-1605 getPaymentsReceivedReport (correctly PAID-only); apps/web/app/(dashboard)/invoices/[id]/page.tsx:2631-2657 (no DRAFT-specific badge in payment row); apps/web/app/(dashboard)/finance/payments/page.tsx:649,824 (Draft badge/filter exists only here).

**Suggested fix:** Standardize every payment-aggregate read (findAll balanceDue, recomputeStatus feeders, bookkeeping dashboards) on `status: PAID` exactly like getCashFlow/getPaymentsReceivedReport already do, and add a 'Draft — unconfirmed' badge to the invoice payment-history row plus a dashboard tile/count for payments awaiting confirmation.

### B57 — Invoice price adjustment leaves PERCENT_OF_SALE excise computed from the old price

**Area:** apps/api/src/invoices/invoices.service.ts — applyPriceAdjustment

**Meant to do:** Adjusting a regulated invoice line's unit price recomputes that line's category/excise tax from the new subtotal.

**Actually does:** applyToInvoice's item loop writes only unitPrice and subtotal; categoryTaxAmount is never touched, then summed stale into taxAmount and mirrored onto the linked order.

**The gap:** PERCENT_OF_SALE lines keep their pre-adjustment excise amount even though the taxable subtotal changed — a persisted, wrong regulated tax record that propagates to the order.

**Evidence:** apps/api/src/invoices/invoices.service.ts:5291-5312 (item update writes unitPrice/subtotal only; categoryTaxTotal summed from the stale stored value), :5313-5322 (totals write); apps/api/src/common/pricing.ts:238-241 (PERCENT_OF_SALE = rate * lineSubtotal); apps/api/src/orders/orders.service.ts:212-256 (recomputeLineCategoryTaxes — the correct pattern, absent here); apps/api/src/invoices/invoices.service.ts:2198, :2224-2252 (recomputeOrderFromInvoices mirrors the stale value onto the order).

**Suggested fix:** In applyToInvoice's item loop, recompute categoryTaxAmount via computeCategoryTax from the new subtotal and persist it, mirroring recomputeLineCategoryTaxes.

### B74 — applyPriceAdjustment never recomputes invoice status after changing the total

**Area:** apps/api/src/invoices/invoices.service.ts

**Meant to do:** A price adjustment that changes an invoice's total recomputes its status from paid-vs-new-total.

**Actually does:** applyPriceAdjustment blocks PAID/WRITTEN_OFF/VOID up front and then rewrites subtotal/taxAmount/total without ever calling recomputeStatus — the helper that ~15 other sites in the same file call after a totals change.

**The gap:** A PARTIAL/SENT/OVERDUE invoice whose lowered total falls at or below what's already paid keeps its stale status instead of flipping to PAID — the status field lies about payment state and misgates write-off and reminder eligibility, both of which branch on it.

**Evidence:** apps/api/src/invoices/invoices.service.ts:5259-5265 (status block list), :5313-5330 (totals write, no recomputeStatus), :247-266 (recomputeStatus), :4721-4726 (writeOff allowedStatuses include PARTIAL/SENT/OVERDUE), :3635-3636 [re-anchored: invoices.service.ts now ~L3626 on master@6c8f1401; was :3635-3636 at hunt round master@e5b0af8e] (sendReminder blocks only VOID/PAID).

**Suggested fix:** After writing the new totals, sum non-VOID payments and call recomputeStatus(totalPaid, total, dueDate, status), persist it, and route any resulting overpayment into a credit note.

### B81 — PATCH payment can reclassify a CREDIT_NOTE/ADVANCE payment to CASH, destroying the wallet balance

**Area:** apps/api/src/invoices — updatePayment

**Meant to do:** A CREDIT_NOTE or ADVANCE payment is undone only through its dedicated reversal path (unapply / advance-balance restore) — voidPayment and deletePayment both guard on the EXISTING payment.method to enforce that, keeping the source wallet mirrored to live payments.

**Actually does:** updatePayment checks only the incoming dto.method (rejecting a PATCH that sets method to CREDIT_NOTE/ADVANCE) and never reads the row's stored method before overwriting it. A PATCH with method 'CASH' on a payment stored as CREDIT_NOTE/ADVANCE silently rewrites it with no balance compensation.

**The gap:** updatePayment is the one sibling with no stored-method guard; the resulting corruption — a customer's credit-note/advance balance permanently wrong and cash fabricated in bookkeeping — is unrecoverable by any existing repair path, and repair queries that filter on method CREDIT_NOTE can no longer see the row.

**Evidence:** apps/api/src/invoices/invoices.service.ts:4567-4572 (guard checks dto.method only), :4599-4614 (unconditional overwrite), :4653-4676 (deletePayment's stored-method guard + ADVANCE restore), :4941-4958 (voidPayment's identical guard); apps/api/src/invoices/dto/create-invoice.dto.ts:91-101 (UpdatePaymentDto.method is required, so every PATCH supplies one); apps/api/src/credit-notes/credit-notes.service.ts:726-741 (repair query filters on method CREDIT_NOTE); apps/api/src/invoices/invoices.controller.ts:255-262 (reachable by any operator-role caller, same as its guarded siblings).

**Suggested fix:** Fetch the existing payment first and reject (or route through the proper reversal) whenever its stored method is CREDIT_NOTE or ADVANCE and dto.method differs — the check its two siblings already have.

### B84 — voidInvoice has no status guard or atomic claim — a double-void double-releases invoicedQty

**Area:** apps/api/src/invoices/invoices.service.ts

**Meant to do:** Voiding an invoice is safe under a double-click or a retried request: exactly one void takes effect and the order's billed-quantity ledger ends up correct either way.

**Actually does:** voidInvoice reads the invoice, checks external payments, then voidInvoiceInTx does a plain `tx.invoice.update({ where: { id } })` with no status filter and unconditionally runs adjustInvoicedQtyForInvoice(..., -1).

**The gap:** No atomic claim (updateMany + status filter + count===0 guard) of the kind every sibling void/refund path uses — two concurrent or retried calls both pass and both decrement invoicedQty. unvoidInvoice has the guard voidInvoice lacks.

**Evidence:** apps/api/src/invoices/invoices.service.ts:3762-3773 (plain update), :3775-3799 (no in-tx re-check), :3813-3860 (unconditional adjust, clamped only to [0, qty]), :3970 [re-anchored: invoices.service.ts now ~L3968 on master@6c8f1401; was :3970 at hunt round master@e5b0af8e] (unvoidInvoice's contrasting guard); the claim pattern in apps/api/src/returns/returns.service.ts:244-250, :347-358 and apps/api/src/credit-notes/credit-notes.service.ts:589-597.

**Suggested fix:** Replace the plain update in voidInvoiceInTx with `updateMany({ where: { id, status: { not: VOID } } })`, abort on count === 0, and only then run adjustInvoicedQtyForInvoice, the ledger reversal and the commission sync.

### B85 — createPartialFromOrder never settles order-level credit-note selections

**Area:** apps/api/src/invoices — partial invoicing

**Meant to do:** An operator's order-level credit-note selection is applied to whichever invoice(s) end up billing that order, including a later partial invoice for backordered lines.

**Actually does:** createPartialFromOrder builds the invoice, bumps invoicedQty and optionally sends it, but never calls settleOrderCreditsInTx anywhere in its body — while send()'s auto-apply deliberately excludes any credit note carrying an explicit-amount OrderCreditNote row, on the assumption settle already ran.

**The gap:** A leftover explicit-amount credit selection is neither auto-applied (excluded by design) nor settled (this path skips it) — it is stranded. Every other invoice-creating path calls settle.

**Evidence:** apps/api/src/invoices/invoices.service.ts:2530-2717 (createPartialFromOrder, no settle call), :1244 (createSplitInvoices calls it), :3550-3560 (send()'s explicitIds exclusion and the comment relying on settle); apps/api/src/orders/orders.service.ts:2017, :2299, :3563 (the other three call sites).

**Suggested fix:** Add `settleOrderCreditsInTx(tx, order.id, tenantId)` alongside the invoicedQty bump — which also means wrapping the function's create + orderItem.update loop in a tenantTransaction (it currently isn't one), mirroring createSplitInvoices's runCreation(tx) shape.

### B97 — Invoice PDF folds unconfirmed DRAFT payments into customer-facing Balance Due

**Area:** Invoices · customer PDF

**Meant to do:** The invoice PDF a customer receives should show Amount Paid / Balance Due from confirmed PAID payments only, like bookkeeping's cash-flow and Payments-Received reports already do.

**Actually does:** PDF payments query filters status:{not:"VOID"}, so DRAFT rows are included; template sums them all into totalPaid/balance and lists them in Payment History with no draft marker.

**The gap:** A save-as-draft payment makes the customer's own invoice document show it as paid — Balance Due $0 on money still owed.

**Evidence:** apps/api/src/invoices/invoice-pdf.service.ts:54-61 (where status not VOID, comment shows only VOID/P5-12 was considered — commit 9f7eaa0b added it); apps/api/src/invoices/invoice-pdf-template.tsx:377-378 (totalPaid=sum all payments), 599-613 (Amount Paid/Balance Due), 618-642 (Payment History, no status shown); apps/api/prisma/schema.prisma:144-148 (PaymentStatus DRAFT/PAID/VOID); apps/web/components/CustomerRecordPaymentModal.tsx:129 (Save-as-DRAFT path); apps/api/src/bookkeeping/bookkeeping.service.ts:994,1605 (PAID-only reference standard).

**Suggested fix:** Change the PDF payments filter to status: "PAID" (or keep DRAFT rows but exclude them from totalPaid and render a 'Pending confirmation' label). Align with the B11 standardization fix.

### B102 — Invoice send/reminder emails show full total as 'Amount Due', ignoring recorded payments

**Area:** Invoicing · email

**Meant to do:** The emailed 'Amount Due' reflects what the customer still owes (total minus payments) — like the PDF, which subtracts totalPaid and prints a separate Balance Due line.

**Actually does:** sendEmail and sendReminder pass only total: Number(inv.total); buildInvoiceEmail's tfoot renders Amount Due = params.total verbatim with no payments parameter in the signature. sendReminder blocks only VOID/PAID, so PARTIAL invoices get dunned for the full amount.

**The gap:** A customer who paid $300 of $500 receives an overdue reminder demanding $500 — the email contradicts the attached PDF.

**Evidence:** apps/api/src/invoices/invoices.service.ts:3501-3523 (sendEmail: total only, no payments), :3635-3636 (reminder guard allows PARTIAL), :3666-3684 (reminder: total at 3674); apps/api/src/email/email.service.ts:661-688 (sendInvoice params — no payments/balance field), :966-970 (tfoot 'Amount Due' = fmt(params.total)); contrast apps/api/src/invoices/invoice-pdf-template.tsx:377-378 (balance = total - totalPaid), :599-613 (Amount Paid + Balance Due lines).

**Suggested fix:** Include payments in the send/reminder invoice query, pass totalPaid/balanceDue to sendInvoice, and render Amount Paid + Balance Due in the email footer mirroring the PDF.

### B103 — Invoice PDF and email omit promo strikethrough and BOGO free-unit disclosure shown on web

**Area:** Invoicing · documents

**Meant to do:** Customer documents disclose discounts the way the web invoice screen does: strikethrough originalPrice with a promo/discount badge, and an 'N free' note on BUY_N_GET_M lines so qty and subtotal reconcile.

**Actually does:** InvoicePdfData's item type and the PDF row renderer carry/print only unitPrice (+MSRP); EmailService.sendInvoice's item type and itemRows are identical. Neither has originalPrice or promoFreeUnits, though InvoiceItem stores both and web renders them.

**The gap:** On BOGO lines qty includes free units with nothing marking them free, so qty × unitPrice ≠ subtotal on the customer's own document; overrides show no savings.

**Evidence:** apps/api/src/invoices/invoice-pdf-template.tsx:61-84 (item type: no originalPrice/promoFreeUnits/priceType), :517-553 (row prints unitPrice + MSRP only); apps/api/src/email/email.service.ts:675-682 (same item shape), :869-883 (itemRows: description/qty/unitPrice/subtotal); apps/api/src/invoices/invoices.service.ts:931-935 ('savings is shown via originalPrice' — discount kept 0, so the doc can't reconcile without it); apps/web/app/(dashboard)/invoices/[id]/page.tsx:2410-2486 (free-units note + strikethrough/badges per priceType); schema.prisma InvoiceItem originalPrice + promoFreeUnits (verified, incl. the comment that free units are billed inside the line).

**Suggested fix:** Add originalPrice, priceType and promoFreeUnits to the PDF/email item payloads; render strikethrough original price (respecting the tenant's hide-original setting) and an 'N free' note under qty, mirroring the web renderer.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
