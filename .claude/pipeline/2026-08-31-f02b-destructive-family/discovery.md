# F02b · Destructive-write guards and tenant scoping (rest of family) — discovery

**Status: EXECUTED** · scale **MAJOR** (destructive paths + tenancy) · base `master 77a8c058`
· Batch F02b, board #515 · IDs: B24, B96, B101, B130, B154, B188 (B126/B127 = F02a, shipped #506).

Register evidence re-confirmed against this base (spot-read at the cited lines; the card's
verbatim triples are the brief — this table records only classification + deltas):

| ID   | Class                                                                                            | Confirmed state on base                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B24  | CONFIRMED                                                                                        | `products.service.ts` `remove()` is guarded AND soft-deletes (`isActive:false`); `bulkDelete()` hard-cascades through **14** dependent tables via `forTenant()` with zero guard. Web detail page's `useDeleteProduct` still dead.                                                                                                         |
| B96  | CONFIRMED                                                                                        | delivered-run refusal still gated `route.kind === RouteKind.ADHOC &&` — SCHEDULED exempt; `routeRunStop.deleteMany`/`routeRun.deleteMany` follow.                                                                                                                                                                                         |
| B101 | CONFIRMED (evidence moved slightly — merge now handles `authorizationOverride`, added post-hunt) | `mergeCustomers` runs in `tenantTransaction` but still `routeRunStop.deleteMany({customerId: secondaryId})` (POD rows destroyed, SET NULL ignored) and still no CustomerLink / AgentAssignment / CommissionAccrual / CustomerCommissionRate / BuyerPaymentRequest / CustomerDocument handling → RESTRICT P2003 500s, CASCADE silent loss. |
| B130 | CONFIRMED (partial #506 improvement noted)                                                       | `batchDelete` NOW has the PAID/SENT pre-flight + `{deleted, failed[]}` (from #506) but still loops `deleteCustomer(id)` **without force** — record-holding customers 409 into `failed[]` (web swallows the detail), record-free ones hard-cascade with no dialog. Detail page soft-deletes with Undo. Divergence stands.                  |
| B154 | CONFIRMED (trusted card + T2 proof)                                                              | web products page `toggleAll` concatenates; no reset on page/search/category change; AssignToSectionModal gets visible subset. Same shape on customers + orders list pages (fix the class).                                                                                                                                               |
| B188 | CONFIRMED (fresh citations, 2026-08-31)                                                          | `bookkeeping/invoice.service.ts` `generateInvoicePdf`: bare `findUnique` + bare `update`; sibling `getPresignedUrl` is `forTenant()` (F1-002). Dormant (no queue producer) — guard BEFORE a producer lands.                                                                                                                               |

**Lane hazard — RESOLVED (its session confirmed 2026-08-31):** hotfix `27795982` on
`claude/relaxed-hodgkin-e12254` is **cherry-picked into this branch as the first commit** (the
session will not land it itself). Facts from its author, verified in their spec: it fixes THREE
purge sites — `deleteCustomer` (~L1812), `deleteAllCustomers` (~L1981), `deleteImportedCustomers`
(~L2130) — each deleting `orderCreditNote` links BEFORE `creditNote.deleteMany`;
`OrderCreditNote` is the ONLY Restrict child of CreditNote (InvoicePayment.creditNoteId SetNull,
CreditNoteItem cascades, Return/regulated-ledger no FK). If B101/B127/B130 rework restructures
these methods, preserve the child-before-parent ORDERING, not the literal diff — the 4
`invocationCallOrder` specs catch regressions. The bug has no register number yet: **mint B189**
(register entry + ledger row, tier T1; retitle the cherry-picked describe blocks to carry
`REG-B189`). Conflict surface of the pick: code-map CHANGELOG/_meta/api.md — keep both CHANGELOG
bullets, REPLACE _meta notes per convention.

**Sibling patterns to reuse (do not redesign):** #506's guards — typed confirmation DTO echoing
the caller's tenantId, PAID/SENT `groupBy` pre-flight with capped breakdown, null-tenant
`ForbiddenException`; `products.remove()`'s active-order-items guard + soft-delete;
vendor-bills' processed-vs-skipped reporting shape.

**G8 inventory (verified numbers from the plan, to re-check in Baseline):** raw
`this.prisma.$transaction(` ≈ 31 occurrences / 18 files (most legitimately non-tenant paths);
`rls.sql` exists, hand-applied only, wraps DDL in `DO $rls$ … WHEN OTHERS THEN RAISE NOTICE`
(swallows its own failures — post-apply assertion mandatory); `apps/api/src/prisma/` has zero
specs. RLS does NOT close anything by itself — it is a backstop for paths already inside
`tenantTransaction`.
