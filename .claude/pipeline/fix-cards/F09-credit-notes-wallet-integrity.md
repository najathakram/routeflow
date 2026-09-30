# F09 · Credit notes and wallet integrity

**Bug IDs (5):** B13, B18, B19, B66, B67

**Root cause:** Credit notes outlive their source invoice's void and can still be issued against a VOID/DRAFT invoice (B66); order-edit settle applies wallet credit to WRITTEN_OFF debt the manual path refuses (B67). Plus the dead DRAFT/Issue flow (B18), raw UUIDs in the list (B19), and web's orphaned apply-advance hook (B13).

**Ships as:** One PR.

**Files:** credit-notes.service.ts · invoices.service.ts · web credit-note pages

**Together because:** One primitive (applyCreditInTx), three entry points, plus the smaller web-side dead-flow/display bugs riding along.

**Guardrails / shared infra:** None new.

**Dependencies / lane notes:** Requires F03 (semantic). Positional predecessor to F08 (same file, credit-notes.service.ts lane: F03 -> F09 -> F08).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F09.jsonl`)

| ID  | Tier | Hunt-round SHA | Citation status     |
| --- | ---- | -------------- | ------------------- |
| B13 | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B18 | T2   | 2d0270fd       | AMBIGUOUS_FILE      |
| B19 | T2   | 2d0270fd       | AMBIGUOUS_FILE      |
| B66 | T1   | e5b0af8e       | MOVED (corrected)   |
| B67 | T1   | e5b0af8e       | TOKEN_NOT_FOUND     |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B13 — No way to apply a customer advance on web

**Area:** Invoices / advances · web

**Meant to do:** An operator should be able to apply a customer's existing advance-payment wallet balance to an open invoice from the web dashboard, the way they already can on mobile.

**Actually does:** `useApplyAdvanceToInvoice` (apps/web/lib/api/invoices.ts:482-499, NOT customers.ts) has zero component callers anywhere in apps/web — no invoice or customer page renders an 'Apply advance' action; web's `useApplyAdvancePayment` (customers.ts:288) is likewise uncalled. Mobile has a working `ApplyAdvanceSheet` (apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:1052,1070-1106) wired to `useApplyAdvancePayment` (apps/mobile/lib/api/customers.ts:172), and its own in-file comment confirms 'web's hook is dead code with no UI' (line 1068).

**The gap:** Claim's file location for the hook is wrong (invoices.ts, not customers.ts); the dead-code/mobile-has-it substance is otherwise accurate.

**Evidence:** apps/web/lib/api/invoices.ts:482-499 (definition, wrong file per claim); apps/web/lib/api/customers.ts:288 (a different, also-uncalled hook); grep of apps/web for ApplyAdvance/applyAdvance shows only these two definitions, no JSX callers; apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:1052,1064-1106 ApplyAdvanceSheet; apps/mobile/lib/api/customers.ts:172; code map .claude/code-map/mobile.md:579-580 corroborates.

**Suggested fix:** Add an 'Apply advance' action to the web invoice detail page (mirroring mobile's ApplyAdvanceSheet) wired to the existing `useApplyAdvanceToInvoice` hook, or delete the dead hook if the feature is deliberately mobile-only.

### B18 — Credit-note Issue flow can never trigger

**Area:** Credit notes · web + mobile

**Meant to do:** A new credit note should start DRAFT and require an explicit Issue action/confirmation before it's live, per the UI's Draft badge, Issue button, and confirm modal.

**Actually does:** CreditNoteStatus has no DRAFT value; create() (and Return.processRefund via the same create()) always writes ISSUED; the issue() service method is a no-op that just re-fetches the note.

**The gap:** status==='DRAFT' can never be true, so the Draft branch, Issue button, and confirmation modal can never render or execute.

**Evidence:** apps/api/prisma/schema.prisma:243-247 (enum, no DRAFT); apps/api/src/credit-notes/credit-notes.service.ts:239 (create ISSUED), 358-360 (issue()=findOne); apps/api/src/returns/returns.service.ts:370-375 (processRefund→create); apps/web/.../credit-notes/[id]/page.tsx:410,653,34-67

**Suggested fix:** Delete the dead DRAFT/Issue UI and no-op issue() endpoint, or implement a real draft workflow (create as DRAFT, make issue() actually flip status).

### B19 — Credit notes display raw IDs instead of invoice numbers

**Area:** Credit notes · web

**Meant to do:** Both the credit-note list and detail page should show the human-readable invoice number so an operator can identify which invoice a credit applies to.

**Actually does:** List renders the raw cn.invoiceId UUID (findAll never joins invoice); detail page also renders cn.invoiceId as link text even though its API call (findOne) does join invoice.invoiceNumber.

**The gap:** Operators see an unreadable UUID in both places; the detail page additionally ignores invoice number data it already has in hand.

**Evidence:** apps/api/src/credit-notes/credit-notes.service.ts:294-297 (findAll, no invoice include) vs 331-338 (findOne, invoice{invoiceNumber} included); apps/web/.../credit-notes/page.tsx:855-856; apps/web/.../credit-notes/[id]/page.tsx:508-516,638-646

**Suggested fix:** Add `invoice:{select:{invoiceNumber:true}}` to findAll's include, and swap `{cn.invoiceId}` for `{cn.invoice?.invoiceNumber ?? cn.invoiceId}` in both list and detail JSX.

### B66 — Credit notes outlive their source invoice's void — and can still be issued against a VOID/DRAFT invoice

**Area:** apps/api/src/invoices + apps/api/src/credit-notes

**Meant to do:** A credit note's validity is tied to its source invoice's receivable: voiding the invoice should void or cap the unused credit issued against it, and no new credit note should be issuable against an already-VOID/DRAFT invoice.

**Actually does:** create() selects the invoice with no status field and no status check, capping only against invoice.total — which void never changes, since voidInvoiceInTx only flips status. voidInvoiceInTx/voidInvoice/deleteInvoice never touch CreditNote rows whose invoiceId points at them, and autoApplyOldestCreditsInTx selects open credits by customer/status/expiry with no source-invoice reference.

**The gap:** A voided invoice's credit notes stay ISSUED and fully spendable elsewhere, and fresh credit notes can still be minted against a VOID/DRAFT invoice's frozen total — the tenant reverses the sale and the customer keeps the money. The manual applyToInvoice path already refuses PAID/VOID/WRITTEN_OFF targets, showing the intent.

**Evidence:** apps/api/src/credit-notes/credit-notes.service.ts:107-138 (create() invoice select/cap, no status), :369-450 (applyCreditInTx, no invoice-status gate), :461-519 (autoApply candidate filter), :522-546 (applyToInvoice's explicit notApplicableStatuses — the contrast), :761-820 (releaseOrderCreditsInTx releases credit SPENT on the voided invoice, not credit SOURCED from it); apps/api/src/invoices/invoices.service.ts:3762-3799 (void, no CreditNote touch), :4779-4783 [re-anchored: invoices.service.ts now ~L4755 on master@6c8f1401; was :4779-4783 at hunt round master@e5b0af8e] (deleteInvoice only nulls invoiceId).

**Suggested fix:** Guard create() against sourcing from a VOID/DRAFT invoice, and have voidInvoiceInTx void or cap any CreditNote whose invoiceId references the invoice being voided.

### B67 — Order-edit settle applies wallet credit to WRITTEN_OFF invoices

**Area:** apps/api/src/credit-notes — settleOrderCreditsInTx

**Meant to do:** WRITTEN_OFF is terminal forgiven debt; wallet/credit-note dollars must never be applied to it. The manual applyToInvoice path refuses it outright, and recordDeliveryPaymentInTx excludes it from PAYABLE with a comment saying written-off debt must not swallow cash.

**Actually does:** settleOrderCreditsInTx — called unconditionally inside every updateOrderItems edit — filters invoices only by `status != VOID`, so WRITTEN_OFF passes. applyCreditInTx has no status gate and creates a CREDIT_NOTE InvoicePayment and increments amountUsed, while recomputeStatus preserves WRITTEN_OFF so the invoice's visible status never moves.

**The gap:** The automatic path silently consumes customer credit against forgiven debt that the manual path explicitly blocks; updateOrderItems gates only on order.status === CANCELLED, never on any invoice's WRITTEN_OFF state.

**Evidence:** apps/api/src/credit-notes/credit-notes.service.ts:914-1002 (filter `status: { not: 'VOID' }` at :929-933, apply loop :972-1000), :369-450 (applyCreditInTx, no gate), :40-58 (recomputeStatus preserves WRITTEN_OFF), :522-546 (applyToInvoice's WRITTEN_OFF block); apps/api/src/orders/orders.service.ts:2533-2551, :3545-3567 (settle invoked on every edit); apps/api/src/invoices/invoices.service.ts:4416-4424 (PAYABLE excludes WRITTEN_OFF), :4719-4751 (writeOff flips status only, leaving a positive balance available).

**Suggested fix:** Exclude WRITTEN_OFF from settleOrderCreditsInTx's invoice query — ideally by reusing applyToInvoice's notApplicableStatuses or recordDeliveryPaymentInTx's PAYABLE list rather than a second hand-rolled filter.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
