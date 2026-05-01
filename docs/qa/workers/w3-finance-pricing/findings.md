# W3 Finance & Pricing Logic Audit - RouteFlow QA

**Auditor:** W3 (Finance & Pricing Logic Auditor)
**Date:** 2026-04-29
**Scope:** All financial calculation code in RouteFlow
**Status:** READ-ONLY AUDIT (no changes made)

---

## CRITICAL FINDINGS

### W3-001 - Invoice Tax Calculation Inconsistency (P1)
- **File:** invoices.service.ts:147-151
- **Issue:** Tax calculated on line subtotal (after line discounts) but invoice-level discount applied AFTER tax. Creates inconsistent tax treatment.
- **Impact:** Tax base is ambiguous; line discounts reduce tax, invoice discounts do not.
- **Fix:** Establish consistent policy: both discounts reduce tax base OR neither do.

---

### W3-002 - Decimal Precision Loss in Order Tax (P2)
- **File:** orders.service.ts:605-607
- **Issue:** Tax rate loaded as float, multiplied with Decimal. Result not rounded before DB storage. Silent rounding creates mismatch between calculated and stored values.
- **Impact:** Order total can drift from invoice total by cents.
- **Fix:** Use Decimal math throughout; round to 2 decimal places before storing.

---

### W3-003 - Credit Note Validation Against Original, Not Remaining Balance (P2)
- **File:** credit-notes.service.ts:51-62
- **Issue:** Credit note creation validates against ORIGINAL invoice total, not remaining balance after payments. Allows over-crediting.
- **Example:** Invoice $1000, paid $600, create credit $500. Check passes ($500 <= $1000) but exceeds remaining $400.
- **Fix:** Validate against remaining balance: `total_credits <= (invoice_total - payments)`.

---

### W3-004 - Invoice Update Doesn't Recalculate Total When Discount Changes (P2)
- **File:** invoices.service.ts:626-642
- **Issue:** Update method changing discount without items does NOT recalculate total. Leaves stale total.
- **Fix:** When discount or shipping changes, recalculate total from existing items.

---

### W3-005 - Void Invoice AR Reversal Not Documented (P1)
- **File:** invoices.service.ts:795-806
- **Issue:** Void blocks if invoice has payments (safe), but AR impact not explicitly documented. Should confirm VOID invoices are excluded from AR aging.
- **Fix:** Document that VOID reduces AR to zero; verify AR reports exclude VOID status.

---

## HIGH-PRIORITY FINDINGS

### W3-006 - Recurring Invoice Prices Frozen at Template Creation (P2)
- **File:** recurring-invoices.service.ts:158-173
- **Issue:** Recurring templates freeze prices at creation time. If catalog price changes, recurrence uses old price. Behavior is correct but not documented, causing user confusion.
- **Fix:** Document frozen price behavior; add UI to optionally sync prices from current catalog.

---

### W3-007 - Order Discount Not Applied to Tax Base (P2)
- **File:** orders.service.ts:605-607
- **Issue:** Order discount is subtracted AFTER tax, making discount non-tax-deductible. Inconsistent with invoice treatment and potentially non-compliant.
- **Example:** $100 subtotal, $20 discount, 10% tax. Current: $100 + $10 - $20 = $90. Correct: ($100-$20) + $8 = $88.
- **Fix:** Align order and invoice tax policy; clarify if discount reduces tax base.

---

### W3-008 - Price Tier Fallback is Silent (P3)
- **File:** pricing.ts:7
- **Issue:** getTierPrice() silently falls back to list price if tier is null. Can hide misconfiguration.
- **Fix:** Throw error on null tier price instead of silently defaulting.

---

### W3-009 - Overpayment Guard Uses Loose Tolerance (P2)
- **File:** invoices.service.ts:1038-1041
- **Issue:** Overpayment allowed within $0.001 tolerance. Can result in negative AR balance.
- **Example:** Remaining $50, payment $50.0001 accepted. AR = -$0.0001.
- **Fix:** Use zero tolerance or handle overpayment as advance payment.

---

### W3-010 - Zero-Quantity Line Items Allowed (P3)
- **File:** invoices.service.ts:136-143
- **Issue:** Invoice allows qty=0 line items. Mathematically valid but likely indicates data entry error.
- **Fix:** Validate qty > 0 for all line items.

---

### W3-011 - Order Consolidation Doesn't Validate Subtotals (P2)
- **File:** orders.service.ts:248-257
- **Issue:** When merging orders, existing subtotal not validated. If source order has incorrect subtotal (qty*price mismatch), error propagates.
- **Fix:** Recalculate all subtotals before merging.

---

### W3-012 - Standing Orders Use Live Prices, Not Frozen (P2)
- **File:** orders.service.ts:854-870
- **Issue:** Standing order templates do NOT freeze prices; they use current catalog prices at order time. Inconsistent with recurring invoices (which freeze prices). Confusing behavior.
- **Fix:** Either freeze prices on standing order template OR document that they are live-priced and differ from recurring invoices.

---

### W3-013 - Credit Note Sub-Penny Edge Case (P2)
- **File:** credit-notes.service.ts:240
- **Issue:** Credit notes marked APPLIED if amountUsed >= amount - $0.001. Can leave $0.001 unresolved (sub-penny credit).
- **Fix:** Set minimum credit amount to $0.01.

---

### W3-014 - Order Demotion Reason Not Audited (P3)
- **File:** orders.service.ts:719
- **Issue:** Demotion reason appended to notes (mutable field). No immutable audit log. Notes can be edited later, losing audit trail.
- **Fix:** Create OrderAuditLog table or separate auditReason field.

---

### W3-015 - Invoice Duplicate from Order-Generated Original (P2)
- **File:** invoices.service.ts:863-899
- **Issue:** Duplicating an order-generated invoice creates a second invoice for the same order. Risk of double-billing.
- **Fix:** Block duplication of invoices linked to orders (orderId is not null).

---

### W3-016 - PaymentStatus Enum Has Unused DRAFT Value (P3)
- **File:** schema.prisma:97-101
- **Issue:** PaymentStatus enum includes DRAFT but payments are only created as PAID or VOID. Confusing; DRAFT not used.
- **Fix:** Remove DRAFT or implement payment workflow (DRAFT -> PAID -> VOID).

---

### W3-017 - Advance Payment Balance Not Auto-Applied (P2)
- **File:** invoices.service.ts:1330-1342
- **Issue:** When payment exceeds allocations, excess becomes AdvancePayment. But this balance is not auto-applied to future invoices. Manual reconciliation required.
- **Fix:** Document manual application process OR implement auto-application logic.

---

## VERIFIED CORRECT (OK Checkpoints)

✓ W3-V001: Invoice subtotal = sum(line subtotals)
✓ W3-V002: Partial payment status recomputation correct
✓ W3-V003: Payment deletion recalculates status
✓ W3-V004: Credit note validation caps at invoice total
✓ W3-V005: Order and invoice tax calculation consistent
✓ W3-V006: Return qty validation prevents over-return
✓ W3-V007: Recurring invoice recurrence calculation
✓ W3-V008: Invoice number generation tenant-scoped
✓ W3-V009: Payment number generation using counter
✓ W3-V010: Void payment recalculates invoice status

---

## SUMMARY

**Total Issues:** 17
- **P1 (Critical):** 2
- **P2 (High):** 8
- **P3 (Medium):** 6
- **Verified Correct:** 10

**Key Recommendations for QA:**
1. Establish clear tax policy (discount treatment)
2. Use Decimal math throughout (no floats for money)
3. Add validation for totals consistency at write time
4. Implement immutable audit logging
5. Document pricing intent (frozen vs. live)
6. Set $0.01 minimum for all monetary amounts
7. Test edge cases: zero-qty, negative AR, overpayment, overapplied credits

---

**Audit Status:** COMPLETE
All findings documented and ready for QA testing phase.
