# Mac mini lane 1 (ba7e1e) handoff, 2026-10-12

State: idle. Nothing running. Lead routes anything further. Weekly usage 88%: do not start work unasked.

## Landed / pushed this stretch (all via normal hooks, full verify green)
| Branch | Sha | What | State |
|---|---|---|---|
| fix/tracked-category-bulk-assign-null | 9360970f4 | bulk assign skipped NULL-category products (NOT col=id) | merged by Lead into R5.2 |
| fix/counter-money-parity | 6d127a0b3 (after 2 train merges) | CQ-01/02/03/08/15/19/28: one order/invoice/till total (orderTotalsOf, saleTotals, invoiceTaxSplit, receiptFigures), exempt customer, named levy lines | merged into R5.2 (live) |
| fix/levy-lines-buyer-mobile | 4fa110112 | row 398: buyer portal, LinkedDocPreviewModal, mobile operator invoice name the levy apart | merged |
| fix/invoice-display-followups | 594aeac39 | mobile customer invoice real tax split; order preview Discount/Shipping rows | merged |
| fix/row411-google-test-authurl-slug | 41668d714 | authUrl built from slug not tenantId | queued for R5.3 |
| chore/money-census-scripts | 58d92c9eb | read-only census reports (exempt orders taxed; SA-780 order discounts); both ran 0 on prod (owner) | pushed |
| feat/counter-category-search | 36eeaf26f | CQ-10: typed category name lists its products in the counter scan field (paginated, same product search) | queued for the next train |

## Reviews delivered
- SA-780 spec review (Opus @high): GATE FAIL, 9 must-fixes + should-fixes, sent verbatim to the SA for SA-780r2 and to Lead.
- Discount drop on edit/merge/CR/finalize is PRE-EXISTING (master 5e231561c identical to train, reproduced on real PG). Two rows for Lead/SA; not fixed.

## Reviews delivered (cont.)
- SA-780r2 spec review (Opus @high): GATE FAIL, 6 new must-fixes (NM1 reduce-then-restore discount loss, NM2 back-sync wipes row-407 evidence, NM3 issued deposit mirror, NM4 basis-blind strict refusal, NM5 merge/CHECK 500, NM6 NSF classification) sent to the SA and Lead. SA-780 is parked.

## Open / not mine
- order-line-removal.db.spec.ts (7 cases 404 -> 409) and order-edit-recipe-version.db.spec.ts (1 case) fail on the train: row-372 assertPayloadLinesHeld (locked-edit-guards.ts:38). Owner of 372 to update the expectations.
- `fix/counter-by-key-draft-incomplete` has an UNPUSHED local commit c612e5b3f (category-tax pin in counter-sale-integrity.db.spec.ts) in worktree rf-wt-342.
- Code-map / lessons bookkeeping follow-ups are pending for every branch above (commits carry `Bookkeeping-Follow-Up: pending`).
  Lesson candidates: (1) Prisma not/notIn/NOT never match NULL on a nullable column (assignProducts, product-list-where); (2) a second formula is how order, invoice and till drifted: one helper plus a per-write tripwire; (3) category-tax-trio-callsites census counts every `categoryTaxAmount:` property, so aggregate sums need a spread or a named helper, not a new literal; (4) api check-types ratchet compiles specs and OOMs at 6144 MB on the train (raised to 8192 in 8685068b2): run `npm run check-types -w apps/api` before pushing.

## Worktrees to clean when disk is tight (>= 10 GB floor, 12 GB free at last check)
- ../rf-wt-parity (merged branch), ../rf-wt-levy (detached/branch fix/row411...), ../rf-wt-342 (has the unpushed pin commit; keep until pushed or dropped).
