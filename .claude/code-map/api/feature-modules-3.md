# api — Feature modules (part 3 of 7): routes & route-optimization, trips, invoices, credit-notes, returns, order-templates, drafts (table of contents)

> Split into part files under [`feature-modules-3/`](feature-modules-3/) on 2026-09-16 (this file
> had grown to 99,998 B against the 100,000 B area cap). Originally itself split from
> `.claude/code-map/api.md` (verbatim, lines 1344-1592) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).
> Pure relocation — no entry's substance was rewritten or shortened, only moved.

| Part file                                                                        | Covers                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`feature-modules-3/routes.md`](feature-modules-3/routes.md)                     | `routes/` & `route-optimization/` — addon gate, controller/service, POD artifacts, driver at-door payment recording (F05), reopen/stop-state guards (F10), cancel/skip reconciliation (F11). |
| [`feature-modules-3/trips.md`](feature-modules-3/trips.md)                       | `trips/` — ad-hoc order trips (2026-08-24, `order_delivery`-gated).                                                                                                      |
| [`feature-modules-3/invoices.md`](feature-modules-3/invoices.md)                 | `invoices/` — invoice service, DRAFT/SENT/PAID lifecycle, reconciliation bases, regulated-sales ledger sync.                                                            |
| [`feature-modules-3/credit-notes.md`](feature-modules-3/credit-notes.md)         | `credit-notes/` — credit note creation, cumulative per-line caps.                                                                                                        |
| [`feature-modules-3/returns.md`](feature-modules-3/returns.md)                   | `returns/` — RMA flow.                                                                                                                                                   |
| [`feature-modules-3/order-templates.md`](feature-modules-3/order-templates.md)   | `order-templates/` — saved order templates, REG-B09 pricing/whitelist pins.                                                                                              |
| [`feature-modules-3/drafts.md`](feature-modules-3/drafts.md)                     | `drafts/` — Minimize & resume (`SaleDraft` model, `DraftDock.tsx`).                                                                                                      |
