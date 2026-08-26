# Plan: Sale integrity phase 2 — qty-zeroing fix, discount carry, reopen/demote/delete freedom, delivery-date picker

> Authored by Fable 5 on 2026-08-25. Status: APPROVED (owner directed, screenshots + live repro)
> Runs on branch feat/customer-feedback-batch AFTER the phase-1 pipeline (wf_933bbf1e) lands.
> This file is the ONLY context implementers/reviewers receive. It stands alone.

## Objective

Five owner-directed items, all root-caused live on prod (read-only) today:

1. **CRITICAL money bug — boxed-payload qty zeroing.** `OrdersService.create()` treats
   `boxes`/`pieces` as authoritative whenever they are non-null; the web New-sale screen sends
   `boxes: 0, pieces: 0`, so `normalizeBoxesPieces` overwrites the operator's qty with **0**.
   Verified on a live order: lines stored `qty 0.000` (boxes/pieces null, unitPrice intact,
   subtotal 0) while the screen showed qty 2 / $180. Downstream this makes the order $0 and
   `createInvoiceFromOrder` correctly finds nothing billable → the "order was created but its
   invoice could not be generated" toast. Fix the server hole + client payload + hard invariant.
2. **Order-level discount dropped on invoice generation.** Verified on demo: order subtotal
   $20, discountAmount $20 (total $0) → generated invoice total **$20**. `createInvoiceFromOrder`
   never reads `order.discountAmount`. Over-billing. Fix with proration across sibling invoices.
3. **Reopen delivered orders (owner: must-have).** `DELIVERED → CONFIRMED` becomes a legal
   staff-only reasoned demotion; generally, **any state may step back one stage**.
4. **Delete any order** (incl. DELIVERED) behind an explicit warning.
5. **New-sale "delivered today" → a delivery-date picker**: past date = backdated delivered
   sale; today = today; future date = scheduled (deliver-later) with that requested date.

## Constraints & conventions

- Prettier double quotes/semicolons/printWidth 100; Jest (api) `Test.createTestingModule`,
  mobile pure-logic only; NO Vitest/snapshots. Conventional commits. Money via
  `apps/api/src/common/pricing.ts` helpers ONLY (`roundMoney`, `normalizeBoxesPieces`,
  `computeLineSubtotal`) — never re-derive boxed line money.
- **Do NOT touch**: `recordDeliveryPaymentInTx`, `reconcile*` internals, `recomputeStatus`,
  `computeDepositFields`, the routes/delivery machinery, `completeStop`/`completeWithPayment`.
- Phase-1 (already on this branch when you start) added: address CRUD, deposit defaults
  (migration 20260905), due-window filter, shipment gating, and on the web order detail it
  REPLACED the DELIVERED "Reopen Order" button with helper text — item 3 now SUPERSEDES that:
  the button comes back, wired to the newly-legal transition. Read the current file state
  first; do not resurrect stale code from memory.
- NO new migration in this phase (schema untouched).
- Live client tenants are never test targets. The damaged live order is NOT repaired by this
  plan (owner repairs via the new reopen → Edit Items flow, or a separate script).

## Verified facts (file:line exact as of master 754df625; phase-1 may shift lines — grep anchors)

- Qty overwrite: `apps/api/src/orders/orders.service.ts` ~L1652-1666 in `create()`:
  ```ts
  if (item.boxes != null || item.pieces != null) {
    const split = normalizeBoxesPieces({
      boxes: item.boxes,
      pieces: item.pieces,
      unitsPerBox: upb,
    });
    qty = split.qty;
    boxes = split.boxes;
    pieces = split.pieces;
  }
  ```
  `OrderItemDto.qty` is `@IsInt @Min(1)`; `boxes`/`pieces` are `@Min(0)` — zeros pass.
  `updateOrderItems` (~L2430+) has a sibling normalization — grep `normalizeBoxesPieces` there
  and audit for the same zero-trap in its ADD/replace branches.
- Sale flow: `createSale` (~L2019) → `create(..., { skipAutoMerge: true })` → step 2 marks
  DELIVERED directly when `dto.deliveredNow` with `deliveredAt: orderDate ?? new Date()` →
  step 3 `createInvoiceFromOrder(order.id, undefined, { dueDate, terms, paymentTermsLabel })`
  → throws the 2068 InternalServerError when it returns []. `CreateSaleDto`
  (`apps/api/src/orders/dto/create-sale.dto.ts`): `deliveredNow: boolean` (required),
  `orderDate?`, `requestedDeliveryDate?`, `send?` (deliver-later only).
- Discount: `createInvoiceFromOrder` (`apps/api/src/invoices/invoices.service.ts` ~L510-660)
  builds `extraInvoiceData` (dueDate/terms/issueDate/shipping copy…) and delegates to
  `createSplitInvoices` (~L901): per-group subtotal from stored line subtotals; the ORDER's
  regular tax is allocated proportionally by subtotal with the largest group absorbing the
  rounding remainder (read that allocator ~L960-1020 and MIRROR its shape for the discount).
  `order.discountAmount` is never read anywhere in the file's generation path (grep confirms).
  The draft-mirror path (`reconcileOrderDraftInvoice`) DOES sync order money — leave it alone.
- Transition map: `orders.service.ts` `changeStatus` ~L2100-2127; demotions requiring
  `dto.reason` are detected via a DEMOTIONS set/check near the map (read it); role gates just
  below (CUSTOMER own-cancel, DRIVER PENDING→CONFIRMED, else staff). Server message L2122.
- Delete: `orders.service.ts` delete/`remove` — currently rejects with
  "Only DRAFT, PENDING, or CANCELLED orders can be deleted." (grep that string). Find what it
  does with invoices for allowed statuses today and PRESERVE that shape for the new statuses.
- Web New-sale screen: `apps/web/app/(dashboard)/invoices/new/page.tsx` — "Going out today?"
  toggle (deliveredNow), Sale date, Terms, Due Date; its items payload is where `boxes:0,
pieces:0` leaks (grep `boxes` in the file and in any shared line-item builder it imports).
- Web order detail: `apps/web/app/(dashboard)/orders/[id]/page.tsx` — post-phase-1 has helper
  text where the DELIVERED Reopen button was; `DemoteReasonModal` + `demoteTarget` machinery
  exists (used by OUT_FOR_DELIVERY). Delete UI + `useBulkDeleteOrders` on `orders/page.tsx`.
- Mobile: `apps/mobile/lib/order-actions.ts` `statusActions(status, fulfillPath)` — DELIVERED
  case has NO reopen (BUG-ORD-01 comment ~L135); demotions carry `requiresReason` style flags —
  read its action shape. `apps/mobile/lib/order-status-flow.ts` `canTransitionOrder` mirrors
  the server map and MUST stay in sync. Tests `apps/mobile/__tests__/order-actions.test.ts`
  assert every action passes `canTransitionOrder`.

## Work packages

### WP1 — API: qty-zeroing fix + line invariant

- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.service.spec.ts`
- **brief:**
  1. In `create()`'s item loop, replace the provided-check with a POSITIVE check:
     ```ts
     // A zero boxes+pieces payload is "not using box entry", not "zero quantity" —
     // the web sale screen sends boxes:0/pieces:0 for plain-qty lines, and the old
     // non-null check let that overwrite a valid qty with 0 (live money bug: lines
     // stored qty 0.000 at full unitPrice, order total $0, invoice ungeneratable).
     if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
     ```
  2. Immediately after qty/boxes/pieces are final (before pricing), add the invariant:
     ```ts
     if (!(Number(qty) > 0)) {
       throw new BadRequestException(
         `Line quantity must be greater than zero${product?.name ? ` (${product.name})` : ""}.`,
       );
     }
     ```
  3. Audit `updateOrderItems` for the same non-null trap in its add/replace/merge branches;
     apply the same positive-check + invariant there (surgical — do not restructure).
  4. Specs: create with `{qty:1, boxes:0, pieces:0}` on (a) non-boxed product → stores qty 1;
     (b) boxed product (upb 24) → stores qty 1 selling unit (box-unaware line, boxes null);
     (c) `{boxes:2, pieces:0}` boxed → normalized as before (regression guard byte-equal);
     (d) all-zero `{qty:1, boxes:0, pieces:0}` never throws; (e) a crafted path that would
     derive qty 0 → BadRequest, order NOT created. And a `createSale` spec: deliveredNow sale
     with `boxes:0,pieces:0` lines → invoice generated (non-empty), totals from qty 1 lines.

### WP2 — API: carry order-level discount onto generated invoices

- **files:** `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/invoices/invoices.service.spec.ts`
- **brief:** In `createSplitInvoices`, allocate `Number(order.discountAmount ?? 0)` across
  groups EXACTLY the way the order's regular tax is allocated (proportional by group subtotal,
  `roundMoney` each share, LARGEST group absorbs the rounding remainder — mirror the existing
  allocator's structure, do not invent a new scheme). Each group's invoice `discount` field
  gets its share and its `total` subtracts it (follow how the existing total is composed —
  subtotal + taxes − discount; keep field names the Invoice model already has, grep `discount`
  on the create data). Guard: when discountAmount is 0/null the create payloads must be
  BYTE-IDENTICAL to today (deep-equal spec). Specs: single-group full-discount order
  (20/20) → invoice discount 20, total 0; split two-group order with discount 15 → shares sum
  to exactly 15 with roundMoney, Σ sibling totals == order total; zero-discount byte-equality.
  Do NOT touch `reconcileOrderDraftInvoice`/partial paths beyond what flows through
  `createSplitInvoices` naturally; `createPartialFromOrder` keeps its current behavior.

### WP3 — API: universal one-step demotion + reopen DELIVERED + delete-any

- **files:** `apps/api/src/orders/orders.service.ts` (changeStatus map/gates + delete),
  `apps/api/src/orders/orders.service.spec.ts`
- **brief:**
  1. Extend the transition map with the missing one-step-back demotions:
     `PENDING += "DRAFT"`, `DELIVERED: ["CONFIRMED", "PARTIALLY_DELIVERED"]` (CONFIRMED = the
     reopen; PARTIALLY_DELIVERED = "it wasn't fully delivered after all"). Every NEW demotion
     joins the requires-reason set and is STAFF-ONLY (OPERATOR/TENANT_ADMIN — extend the
     existing role-gate block; CUSTOMER/DRIVER get 403 for them).
  2. DELIVERED→(CONFIRMED|PARTIALLY_DELIVERED) additionally: (a) 409 ConflictException when
     `order.routeRunStopId` is set AND that RouteRunStop.status === "COMPLETED" — message:
     "This order was delivered on a route run. Reopen its stop from the run instead — that
     reverses stock and payments correctly." (single extra lookup, only on this transition);
     (b) on success clear `deliveredAt` (data: { status, deliveredAt: null }).
     The DELIVERED branch's side effects (invoice settle etc.) must NOT run for demotions —
     they are keyed on `dto.status === DELIVERED`, verify nothing else fires.
  3. Delete-any: in the delete path, replace the status allowlist with: staff may delete ANY
     status EXCEPT when a linked invoice is PAID/PARTIAL (or has payments) → 409:
     "This order's invoice has recorded payments — void the invoice first." DRAFT/SENT/VIEWED
     linked invoices are deleted/voided the same way the current allowed-status path already
     handles them (read it; reuse; if today it refuses when ANY invoice exists, keep that rule
     for non-draft invoices only and cascade DRAFTs). CUSTOMER role keeps today's rules
     (own DRAFT/PENDING only). Order deletion must also null out run links the way
     `deleteRoute` does (`routeRunId/routeRunStopId` are ON the order row itself — deleting
     the row is enough; just ensure no FK violation from DeliveryMutation/ChangeRequest —
     grep their relations; if restrict-linked, 409 with the run message from 2 instead).
  4. Specs: each new demotion allowed with reason + staff (and 400 no-reason / 403 driver);
     DELIVERED demotion clears deliveredAt; run-stop-completed 409; delete DELIVERED order
     with no payments → gone (+ draft invoice cascaded); with PAID invoice → 409.

### WP4 — API: delivery-date picker semantics

- **files:** `apps/api/src/orders/dto/create-sale.dto.ts`, `apps/api/src/orders/orders.service.ts` (createSale only), `apps/api/src/orders/orders.service.spec.ts`
- **brief:** `CreateSaleDto` gains `@IsOptional() @IsDateString() deliveredOn?: string` —
  when present it REPLACES `deliveredNow`'s binary:
  - deliveredOn ≤ today (tenant-tz calendar compare, same util the backdate path uses for
    `orderDate`): behave as deliveredNow=true AND set `deliveredAt` to that date (parse via
    the existing `parseOrderDate`-style staff gate — backdating stays staff-only);
  - deliveredOn > today: behave as deliveredNow=false and set
    `requestedDeliveryDate = deliveredOn`.
    `deliveredNow` stays accepted for backward compat (mobile/new clients may still send it);
    when both present, `deliveredOn` wins. Specs: past date → DELIVERED with deliveredAt = that
    date + invoice issued; future date → PENDING mirror-draft flow with requestedDeliveryDate;
    non-staff backdate rejected (mirror parseOrderDate's rule).

### WP5 — Web: New-sale date picker + reopen button + delete-any UI

- **files:** `apps/web/app/(dashboard)/invoices/new/page.tsx`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/lib/api/orders.ts`
- **brief:**
  1. New-sale: replace the "Going out today? [Yes, delivered today]/[No, deliver later]"
     binary with three-state: **Delivered** (default date = today, editable, max = today …
     actually allow ANY date: past/today ⇒ delivered semantics) / **Deliver later** (date
     field = requested delivery date, min tomorrow). Implement as: keep the two buttons,
     add a "Delivery date" date input next to them that drives `deliveredOn`; "Yes" preselects
     today; picking a future date auto-switches to deliver-later semantics (and the copy
     updates: "Scheduled — the order is created and delivers on {date}"). Send `deliveredOn`;
     keep sending `deliveredNow` for compat. ALSO fix the items payload: never send
     `boxes: 0, pieces: 0` for plain-qty lines (omit the keys unless the operator used box
     entry) — the server now tolerates it, but the payload should be honest.
  2. Order detail: restore **Reopen Order** on DELIVERED wired to the (now legal)
     reasoned demotion via the existing `DemoteReasonModal` (`setDemoteTarget("CONFIRMED")`);
     keep phase-1's helper text as the button's subtext, reworded: "Reopening keeps the
     invoice — Edit Items re-syncs it. Route-delivered orders reopen from their run stop."
     Surface the server's 409 (run-stop case) via the standard error toast. Add a
     "Delete order" action for staff on any status (inline two-tap confirm + typed word?
     use the SAME inline confirm idiom the page/bulkbar already uses, with copy: "Delete this
     DELIVERED order? Its delivery record is removed permanently."); 409s toast the server
     message.
  3. `lib/api/orders.ts`: nothing new needed beyond ensuring the delete hook surfaces server
     error messages (check).
- **dependsOn:** WP1, WP3, WP4

### WP6 — Mobile: mirror reopen/demote/delete + sale date

- **files:** `apps/mobile/lib/order-actions.ts`, `apps/mobile/lib/order-status-flow.ts`,
  `apps/mobile/__tests__/order-actions.test.ts`, `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`
- **brief:** `order-status-flow.ts`'s map mirrors the server additions EXACTLY (PENDING→DRAFT,
  DELIVERED→CONFIRMED|PARTIALLY_DELIVERED). `order-actions.ts` DELIVERED case gains
  "Reopen order" (toStatus CONFIRMED, requiresReason, destructive-neutral styling) — update
  the BUG-ORD-01 comment: policy reversed by owner 2026-08-25, the transition is now legal
  server-side with a run-stop 409 guard. Order detail screen: delete action available on any
  status for staff with `confirm()` warning; 409 toasts server message. Mobile New-sale
  (van-sale) screens are NOT in scope for the date picker (driver flow is "now" by
  definition) — only ensure nothing breaks from the DTO addition. Tests: new actions pass
  `canTransitionOrder`; DELIVERED offers exactly [Reopen order, …existing non-transition
  actions]; map parity spot-checks.
- **dependsOn:** WP3, WP4

### WP7 — Code map + CHANGELOG

- **files:** `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`,
  `.claude/code-map/CHANGELOG.md`, `.claude/code-map/_meta.json`
- **effort:** low
- **dependsOn:** WP1–WP6
- **brief:** Surgical updates (qty invariant + positive box check; discount proration;
  transition-map liberalization + run-stop guard; delete rules; deliveredOn). EXTEND the
  phase-1 dated bullet rather than adding a second same-day bullet. REPLACE `_meta.json` notes.

## Acceptance criteria

1. A sale sent with `{qty:1, boxes:0, pieces:0}` per line stores qty 1, prices correctly, and
   generates its invoice — the screenshot flow succeeds end-to-end. No path can persist an
   order line with qty ≤ 0 (server invariant).
2. A fully-discounted order generates an invoice with the discount applied (total $0); split
   orders prorate exactly (Σ siblings == order total); zero-discount payloads byte-identical.
3. DELIVERED orders: staff can Reopen (reason required) → CONFIRMED with `deliveredAt`
   cleared; run-delivered orders get the 409 pointing at the run stop; web + mobile expose it.
4. Every state can step back one stage (staff, reasoned); map mirrored in mobile
   `order-status-flow`; specs cover each edge.
5. Staff can delete an order in any status after an explicit warning, except when its invoice
   has payments (409 explains voiding first).
6. New-sale has a delivery date: past = backdated delivered sale (`deliveredAt` = chosen
   date), future = scheduled deliver-later; backdating stays staff-only.
7. `npm run verify` green; phase-1's specs still green (esp. its byte-identical guards).

## Verification commands

- perRound: `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- final: `npm run verify`

## Risks & rollback

- WP1's positive-check touches the money-entry path: the (c) regression spec pins real box
  entry byte-equal; reviewers adversarially check `updateOrderItems` branches too.
- WP2 mirrors the existing tax allocator — reviewer must diff the two allocators side-by-side
  for shape parity and check Σ-to-the-cent specs.
- WP3 liberalizes transitions: reviewer verifies NO DELIVERED-branch side effects fire on
  demotions and the CUSTOMER/DRIVER gates hold.
- Rollback: squash revert; no schema changes.
