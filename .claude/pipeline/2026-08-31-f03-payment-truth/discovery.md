# F03 · Payment-status truth and invoice documents — discovery

**Status: EXECUTED (authoring); citations re-confirmed at pipeline Baseline)** · scale **MAJOR**
(money + invoices lane head) · base `master e7eb1627` (post-F01) · board #516 · IDs B11, B57,
B74, B81, B84, B85, B97, B102, B103 · **money batch ⇒ Fable adversarial pass at close-out.**

The brief is the F-card (`.claude/pipeline/fix-cards/F03-…md`) — nine verbatim triples with
line-cited evidence. Five IDs carry MOVED/disambiguate flags from the citation audit: the
executor's Baseline grounding confirms each within its already-named file (never a repo sweep).

## The W-answers (owner directive: every batch answers them)

- **WHO** is hurt: every tenant's operators (balances/dashboards lie when a DRAFT payment
  exists), their customers (PDF says Balance Due $0 on money still owed; reminder emails dun the
  full total after a partial payment), and regulated-tax auditors (stale excise after price
  adjustments).
- **WHAT** it costs: real money misstatements on customer-facing documents; collections chasing
  wrong amounts; an invoice-status field that write-off and reminder eligibility branch on while
  it lies.
- **WHY** one batch: one root cause — `status: { not: "VOID" }` where "confirmed payment" was
  meant — appears across findAll, three bookkeeping dashboards, the PDF query; plus the two
  document renderers (PDF/email) that must move together, and the invoice-totals writers that
  skip `recomputeStatus`.
- **WHY NOW**: F07/F09/F16 semantically depend on the predicate this batch defines.
- **WHEN fixed, the signal**: dashboards/PDF/email agree with `getCashFlow`'s PAID-only numbers
  to the cent; the repair lane's integrity re-check shows zero status-drift rows.

## The one design decision the whole batch hangs on

Introduce a single named predicate — `CONFIRMED_PAYMENT` (`{ status: "PAID" }`) — exported from
the invoices module and used by **every money-summing read**. Classification rule for discovery
inside the executor: a site that **sums or advances state** on payments uses CONFIRMED_PAYMENT;
a site that **lists** payments keeps `not: VOID` and must render the DRAFT state visibly
(B11's badge). `getCashFlow`/`getPaymentsReceivedReport` are the already-correct reference.

## Repair lane (owner decision 2026-08-31: repair-as-we-go)

This batch's bugs WROTE damage that outlives the code fix. In scope for its repair script:

| Damage class                                       | From                                   | Identification (read-only)                                           | Repair                                                  |
| -------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Stale `invoice.status` vs payments/total           | B74 (and any historic recompute skips) | `recomputeStatus(paidSum, total, dueDate)` ≠ stored status           | set recomputed status                                   |
| Stale `categoryTaxAmount` on PERCENT_OF_SALE lines | B57                                    | recompute from current subtotal ≠ stored                             | write recomputed value + resum invoice.taxAmount        |
| Stranded explicit OrderCreditNote selections       | B85                                    | explicit-amount rows never settled though the order is invoiced      | settle via the fixed path (or report-only if ambiguous) |
| invoicedQty double-release drift                   | B84                                    | conservation check (Σ non-VOID invoice qty vs orderItem.invoicedQty) | restore conserved value                                 |
| Reclassified CREDIT_NOTE/ADVANCE payments          | B81                                    | **unidentifiable post-hoc** (method overwritten)                     | UNREPAIRABLE — recorded, not attempted                  |

Repairs run **after** the fixed code deploys (else rows re-drift), behind: fresh backup →
dry-run printout → apply → scoped integrity re-check, following `repair-integrity.mjs`'s safety
shape (tx-locked re-read, JSONL repair log to `local-assets/`).
