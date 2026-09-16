# api — Feature modules (part 4 of 7): inventory, billing, estimates, vendor-bills (table of contents)

> Split into part files under [`feature-modules-4/`](feature-modules-4/) on 2026-09-16 (this file
> had grown to 99,637 B against the 100,000 B area cap). Originally itself split from
> `.claude/code-map/api.md` (verbatim, lines 1593-1793) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).
> Pure relocation — no entry's substance was rewritten or shortened, only moved.

| Part file                                                                   | Covers                                                                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`feature-modules-4/inventory.md`](feature-modules-4/inventory.md)         | `inventory/` — controller/service, AVCO/FIFO/LIFO/STANDARD/LAST_COST costing, PR-C stock-count sessions, PR-D variant-assign, POs, receiving box→piece conversion. |
| [`feature-modules-4/billing.md`](feature-modules-4/billing.md)             | `billing/` — addon gate + registry/feature-registry, plans-as-data catalog, entitlements, subscription mutation (cancel/resume/Stripe propagation), MRR engine. |
| [`feature-modules-4/estimates.md`](feature-modules-4/estimates.md)         | `estimates/` — estimate controller/service, DRAFT→SENT→ACCEPTED/DECLINED→CONVERTED lifecycle.                                            |
| [`feature-modules-4/vendor-bills.md`](feature-modules-4/vendor-bills.md)   | `vendor-bills/` — AP bill scan/create/receive, duplicate-invoice guard, AP payment allocation + supplier credit, prod repair/report scripts. |
