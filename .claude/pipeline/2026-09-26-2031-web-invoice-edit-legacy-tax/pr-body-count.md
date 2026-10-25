## Production exposure (read-only count, SA-368 · R-030)
Run by the owner (not by this lane) with local-assets/handoff/2026-09-26/b2031-legacy-tax-count.mjs (READ ONLY txn, rolled back; shared classifyInvoice rule); result relayed by the Mac Lead, 2026-09-26.
- 52 legacy header-tax invoices across 2 tenants (tenant A / tenant B): VERIFIED 52 · UNVERIFIED 0 · POSTFIX 0.
- So the B294 backfill has not been applied in prod; every one of the 52 would lose its sales tax on a web edit save today. The SA-368a unverified block does not fire for any current prod invoice.
- Per-status (DRAFT-editable) split: not in the relayed result.
