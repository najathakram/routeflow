# B861 — sibling sweep (post-fix tree, 12a83d10)

| Pattern                                  | Hit                                                          | Verdict                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| raw-SQL regex from an interpolated value | `numbering.service.ts` findTakenNumeric / scanMaxForYear (6) | same-class-but-guarded — `escapeRegex` on every pattern (this fix)                        |
|                                          | `scripts/report-b861-numbering-config.mjs:107`               | same-class-but-guarded — escaped, read-only report                                        |
|                                          | `orders/order-number.ts:49` `ORDER_SEQ_PATTERN`              | unrelated — a constant, no tenant input                                                   |
| numbering-store writers                  | `numbering.service.ts` :205/:217/:228/:391/:396/:595         | same-class-but-guarded — the one owner                                                    |
| per-year numbers built by hand           | `scripts/backfill-invoices.js:19`                            | defect, already filed **B273**                                                            |
|                                          | `scripts/import-zoho.js:397` local `invoiceSeq` from 1       | **defect — file new** (B268-class; ignores both the per-year series and a saved card row) |
|                                          | `scripts/demo-seed.js:1432`                                  | same-class, scoped — seeds `routeflow-demo` only                                          |

To file at close-out (SA-274 "siblings, not widened"): import-zoho fallback counter; PAYMENT numbering
continuity (PaymentCounter, `PAY-<tenant>-####`, no card row since B861).
