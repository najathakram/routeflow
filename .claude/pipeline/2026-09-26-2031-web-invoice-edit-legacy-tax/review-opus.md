# In-lane review (Opus 5.5 @ high, feature-reviewer, read-only) · PASS WITH NOTES · ~04:55Z
SA-368 conformance holds; categoryTaxAmount reaches the helper (findOne include → useInvoice r.data untransformed; Decimal string handled by Number()). Money: plain 8.25 / regulated 13.25 pinned on the real edit-plan functions; stored >0 never overwritten; untaxed never gains a rate. Guard enforced on button (:1011) + handleSubmit (:546). Tests behavioural, no pin weakened.
1 MAJOR (design, SA-368 literal): exempt-line SAVE TRAP — unverified population is mostly mixed-exempt/excise-mismatch (a true flat 4-dp rate always verifies); operator can only save by giving an exempt line a non-zero rate (money-changing). A newly added 0% fee line is also blocked. → escalated to SA.
2 MAJOR (in scope): Playwright 1440/768/390 for the unverified state not yet produced; PR-body prod count owed.
3 MINOR (inherited SA-141): a blended rate that happens to verify is stamped on exempt lines; header preserved on no-op save, but deleting the exempt line then under-taxes.
4 MINOR: handleSubmit guard :546 has no direct test (button disabled first).
5 NOTE: regulated idempotence fixture uses PERCENT_OF_SALE only; per-unit excise not covered.
