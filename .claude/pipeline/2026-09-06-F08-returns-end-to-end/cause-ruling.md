# Fix ruling — F08 (B53 · B68 · B69 · B82 · B20 · B61 · B166 · B75 · B128 · B21) returns end-to-end

> Fable @ high, 2026-09-06. Inputs: the committed plan `.claude/pipeline/2026-09-02-wave-a-completion/F08.md`
> (adversarially verified 2026-09-02) + `SEQUENCE.md` rulings R2/R3/R5/R6, the verified corrections
> `local-assets/handoff/2026-09-06/bug-plan/corrections-F08.md`, S1 `cause-brief.md` and S2 `refutation.md` in this
> run dir (attached when they land; amended only where S2 refutes). Base: master `597c72dc` (contains F09 #636:
> `credit-notes.service.ts` `create()` now refuses VOID/WRITTEN_OFF sources; `invoice-status-sets.ts` exists),
> worktree `rf-F25`, branch `fix/F08-returns-end-to-end`. Owner ruling 2026-09-06: carve-out GO.

## 1. Cause verdicts (accepted from the plan; S2 confirms lines on 597c72dc)

| Bug  | Verdict                                        | Diverging behaviour                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B53  | confirmed (register's fix REFUTED)             | `processRefund` prices the refund Σ qty × (orderLine.subtotal/qty) from ORDER lines, never from the issued invoice; with 2+ Invoice rows it mints the credit note with `invoiceId` undefined, skipping the cap. The register's `min(orderedQty, deliveredQty)` cap would REGRESS: `deliveredQty` is written only by `completeWithPayment`; the ordered-qty cap is the correct physical ceiling. |
| B68  | confirmed                                      | RECEIVED→REFUNDED claim is a non-transactional `updateMany` (also writes refundMethod/refundAmount/refundedAt); `creditNotes.create()` runs in its own tx afterwards; a failed mint strands the row (re-entry refused, cancel refuses REFUNDED).                                                                                                                                                |
| B69  | confirmed                                      | `cancel()` reads the return OUTSIDE the tx; the undo branch keys on the stale closed-over `ret.status`/`ret.items` while the claim `updateMany` matches a concurrently-committed RECEIVED → reversal skipped or run on stale restock flags.                                                                                                                                                     |
| B82  | confirmed                                      | quota query `status: { not: 'REJECTED' }` counts CANCELLED returns, which have zero in-force effects.                                                                                                                                                                                                                                                                                           |
| B20  | confirmed (schema half already shipped by F01) | `create()`'s nested item map writes only productId/qty/reason/restock/tenantId; `condition`/`notes` columns exist and the detail page already renders them.                                                                                                                                                                                                                                     |
| B61  | confirmed (+ web sibling)                      | driver screen AND the web create modal send no `restock`; server defaults `restock: i.restock ?? true`; DAMAGED/QUALITY returns restock into sellable stock.                                                                                                                                                                                                                                    |
| B166 | confirmed                                      | web sends `search`; controller binds only orderId/customerId/status/reason/page/limit; no OR clause in `findAll`.                                                                                                                                                                                                                                                                               |
| B75  | confirmed                                      | KPI and row Value sum `(item.unitPrice ?? 0) * qty`; `ReturnItem` has no price column; `findAll` derives none → always $0.00.                                                                                                                                                                                                                                                                   |
| B128 | confirmed                                      | driver return rows use `quantityDelivered` (the DELIVERED side): REFUSED → qty 0 → server 400; PARTIAL → credits goods the customer kept; amount re-derives qty × unitPrice (boxed lines).                                                                                                                                                                                                      |
| B21  | confirmed                                      | `POST /returns/:id/cancel` exists; web has no cancel mutation/control; mobile `useCancelReturn` has zero importers; `returnActionFlags` has no `canCancel`.                                                                                                                                                                                                                                     |

## 2. Fix design (minimal diff) — F08.md §Fix per bug, with these bindings

- **B53:** private `billedBasisFor(returnItems, order)` in `returns.service.ts`: from the order's NON-VOID invoices (`items: { productId, qty, subtotal }`), per returned product `billedQty = Σ qty`, `perUnitBilled = Σ subtotal / billedQty`, `refund = min(item.qty, billedQty) × perUnitBilled` (`roundMoney`); fall back to the order-line math ONLY when the order has zero Invoice rows of any status. `processRefund` and `findOne.refundEstimate` (and B75's `findAll`) all call the ONE helper (L-030). `invoiceId` to `creditNotes.create` = the single non-VOID invoice; with 2+ non-VOID invoices compute `headroom = Σ non-VOID totals − Σ non-VOID credit-note amounts` and throw `BadRequestException` when `refundAmount > headroom + 0.001`. Do NOT change the `create()` cap; do NOT touch `receive()` restock; **do NOT edit `routes.service.ts`** (R2).
- **B68:** wrap `creditNotes.create` in try/catch; on failure compensate with `updateMany({ where:{ id, status:'REFUNDED', creditNoteId:null }, data:{ status:'RECEIVED', refundMethod:null, refundAmount:null, refundedAt:null } })` then rethrow. Keep the sequential (non-nested) design.
- **B69:** inside the `tenantTransaction`, before the claim: `tx.$executeRaw\`SELECT id FROM "Return" WHERE id = ${id} FOR UPDATE\``then`fresh = tx.return.findUnique({ where:{id}, include:{items:true} })`; decide the undo on `fresh.status`and iterate`fresh.items`. Outer read stays only for 404/ownership/early-status checks.
- **B82:** `status: { notIn: ['REJECTED','CANCELLED'] }` at the quota query. Nothing else.
- **B20:** nested map gains `condition: i.condition ?? undefined, notes: i.notes ?? undefined`; `CreateReturnItemDto` (packages/types) gains optional `condition`; no client change required.
- **B61:** server `defaultRestockForReason(reason)` (DAMAGED, QUALITY_ISSUE → false; WRONG_ITEM, CUSTOMER_REFUSED, EXCESS_ORDER → true) applied as `restock: i.restock ?? defaultRestockForReason(i.reason ?? dto.reason)`; mirror `restockForReason` in `apps/mobile/lib/returns-logic.ts` so the driver payload is explicit. Per-item office toggle deferred (D5).
- **B166:** `@Query('search')` on the controller; `findAllForUser → findAll` take an options object; `where.OR` on returnNumber / order.orderNumber / customer.businessName (`contains`, insensitive) ANDed with existing filters (CUSTOMER role's customerId still applies).
- **B75:** `findAll` returns `refundEstimate` per row via `billedBasisFor` (include order.lineItems + non-VOID invoice items); web KPI + row Value sum `r.refundEstimate ?? 0`; delete the client-side `qty × unitPrice` reduce.
- **B128:** pure `undeliveredReturnLines(stop)` in `apps/mobile/lib/returns-logic.ts`: PARTIAL|REFUSED mutations → `undelivered = max(0, ordered − quantityDelivered)`, skip ≤ 0; amount = `lineItemSubtotal(li) − prorateLineSubtotal(li.subtotal, delivered, ordered, freeUnits, freeUnitSizeFor(li))`; reason via the label map; restock via `restockForReason`. The driver screen uses ONE call for rows, total and payload; toast when every row is zero.
- **B21:** web `useCancelReturn()` + a confirm-modal "Cancel return" button on `[id]/page.tsx` for status ∈ {PENDING, APPROVED, IN_TRANSIT, RECEIVED}; mobile `canCancel` in `returnActionFlags` + an ActionTile in operator `[id].tsx` wired to the existing hook; delete the `useCancelReturn` suppression at `.claude/skills/bug-hunt/scan-ignore.json:35`.
- **Must NOT change:** the `create()` ordered-qty cap; `receive()` restock quantities; `routes.service.ts` (hand F11's layer the finding that `completeStop` never writes `deliveredQty` → new registry row); `credit-notes.service.ts` (F09's new source guard is read, not edited — S2 confirms B53/B68 compose with it).
- **Invariants:** refunds are priced from what was BILLED, never re-derived from order lines; a claim and its side effects are atomic or compensated; only returns whose effects are in force consume quota.

## 3. Regression tests — `bug-test-plan.md` (T1–T16); REG tokens per bug id.

## 4. Blast radius (`radiusFiles`)

`apps/api/src/returns/returns.service.ts`, `returns.controller.ts`, `returns-refund.spec.ts`, `returns-overreturn.spec.ts`,
`apps/api/src/credit-notes/credit-notes.service.ts` (read), `apps/api/src/orders/orders.service.ts` (read: deleteOrder),
`packages/types/api/*returns*` (DTO), `apps/mobile/lib/returns-logic.ts`, `apps/mobile/__tests__/returns-logic.test.ts`,
`apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx`, `apps/mobile/app/(operator)/returns/[id].tsx`,
`apps/web/lib/api/returns.ts`, `apps/web/app/(dashboard)/returns/page.tsx`, `apps/web/app/(dashboard)/returns/[id]/page.tsx`,
`apps/web/e2e/29-returns-lifecycle.spec.ts`, `apps/web/playwright.config.ts`.

## 5. Sibling patterns (`siblingPatterns`)

- `\.subtotal\s*/\s*\w+\.qty` — money re-derived per unit from an order line (L-030 / money discipline).
- `status: \{ not: "REJECTED" \}` — a single-status exclusion where the in-force set belongs.
- `unitPrice \?\? 0\) \* ` — client-side qty × unitPrice on a possibly boxed line.
- `restock: i\.restock \?\? true` — a restock default that ignores the reason.

## 6. Data repair (owner-owed, never bundled)

(B53) Return rows with `refundAmount` above the billed basis and (B68) rows `status REFUNDED, refundMethod CREDIT_NOTE, refundAmount > 0, creditNoteId null` are identifiable → ONE read-only report script (`scripts/report-f08-return-refunds.mjs`, prod via `railway run --service postgres`, dry-run only), delivered separately; the owner decides re-mints. (B69) races are unrepairable after the fact — recorded.

## 7. Probe plan (`revertFix: true`)

| File                                      | REG test that must go red |
| ----------------------------------------- | ------------------------- |
| `apps/api/src/returns/returns.service.ts` | REG-B53 (T1a)             |
| `apps/mobile/lib/returns-logic.ts`        | REG-B128 (T12)            |

## 8. Close-out bindings

One PR (D6); commits carry `Bookkeeping-Follow-Up: pending`; `prove` (T1) / `--pending-deploy` (T2: B166, B75, B21) / `discharge` after deploy + E2E, and the lesson (archive TWO first; id from `nextId`) go in the lead's docs-only follow-up. New registry rows to file: `completeStop` never writes `deliveredQty` (routes layer); driver "Adjust order" + return double-restock (pre-existing); office per-item restock toggle (feature, D5).

## 9. Amendment 2 — S2 rulings (Fable, after `refutation.md`; these override §2 where they differ)

- **B53 creditable set:** the invoice filter is `status: { notIn: CREDIT_SOURCE_EXCLUDED }` from `apps/api/src/invoices/invoice-status-sets.ts` (VOID + WRITTEN_OFF), never a bare `not: 'VOID'` — otherwise F09/B66 re-opens and `returns-refund.spec.ts:123-160` (a tripwire that must stay green) goes red.
- **B53 fallback:** count the order's invoices WITHOUT a status filter. Zero invoices at all → legacy order-line basis (pre-invoicing orders). Invoices exist but none creditable → `BadRequestException("Nothing billed on this order can be refunded")`, never the order-line basis.
- **B53 `findOne`:** its select has no `invoices` today — add the same creditable-invoice select so `refundEstimate` uses the helper.
- **B53 headroom (2+ creditable invoices):** mint against the LATEST creditable invoice (`invoiceId` set, so the create() cap applies) and compute `headroom = Σ creditable invoice totals − Σ non-VOID credit notes linked to the ORDER` (by `orderId` if `CreditNote` has it; else `invoiceId ∈ creditable ids OR (invoiceId IS NULL AND customerId = order.customerId AND createdAt ≥ order.createdAt)` — the implementer verifies the model and states which); refuse when `refund > headroom + 0.001`. Gate the branch on `creditable.length >= 2` only.
- **B53 × B128 composition (the batch's key ruling):** a return must know whether its units were BILLED. `CreateReturnItemDto` gains optional `deliveredQty` (number). Driver B128 rows send `deliveredQty = m.quantityDelivered`; other clients omit it. Helper: with ordered `O`, billed `B` (Σ creditable invoice item qty), returned `q`: `refundQty = item.deliveredQty != null ? min(q, max(0, B − item.deliveredQty)) : min(q, B)`. Ordered-basis invoice (B = O) → undelivered units refund in full; delivered-basis invoice (B = D) → undelivered units refund 0 (they were never charged); kept-goods returns keep `min(q, B)`. Tests: T1d (below).
- **B69 harness:** `prisma-mock.ts` spreads the same models into `tx`, so REG-B69 must override `tenantTransaction` itself with a distinct tx object whose `return.findUnique` returns RECEIVED while the outer read returns APPROVED.
- **B61 is broader:** mobile `returns-logic.ts:71` (`buildReturnItems`) and operator `new.tsx:268` default `restock` to an explicit `true`, which short-circuits the server default — both become `restockForReason(reason)`; `returns-logic.test.ts:68, 73, 80` are rewritten accordingly (P7/P8).
- **B128:** `lineItemSubtotal` does not exist in `@routeflow/pricing` — use the real exports (`computeLineSubtotal` and the boxed proration helper; the implementer names them from `packages/pricing/src/index.ts`); `issue()` must group rows by `orderId` and post ONE return per order (a stop can carry several orders) — the mobile helper returns rows grouped by order.
- **Tests to rewrite (pinned wrong behaviour):** `returns-refund.spec.ts:76, 88, 100-121, 262, 290`; `returns-overreturn.spec.ts:110-113`; `returns-logic.test.ts:68, 73, 80`. Tripwires that must stay green: `returns-refund.spec.ts:123-160`, `returns-ledger.spec.ts:61-89`.
- **Line drift:** every `returns.service.ts` citation past ~:319 in F08.md is ~9 lines lower on this tree (F09's comment block); the engine re-derives, never trusts.
