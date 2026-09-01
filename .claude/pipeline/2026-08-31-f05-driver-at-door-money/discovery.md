# F05 · Driver at-door money and settlement — discovery

**Status: EXECUTING** · scale **MAJOR** (money + driver cash custody) · base `master 26037bd4` ·
Batch F05, board **#518** · IDs B49 (Critical), B83, B148, B152, B167 · **money batch ⇒ the
standing Fable adversarial pass over the final diff applies at close-out.**

Classification: **B49 CONFIRMED · B83 CONFIRMED · B148 CONFIRMED · B152 CONFIRMED · B167
CONFIRMED** — all on `master@26037bd4`, none already-fixed. Re-anchor flags (B49 MOVED, B148
FILE_NOT_FOUND, B152 AMBIGUOUS_FILE, B167 OUT_OF_BOUNDS, B83 routine) all resolved by direct read
within the cited files; corrected anchors below. Zero `REG-B(49|83|148|152|167)` tokens exist in
any spec — all five proofs are unpinned today.

## Corrected anchors (register → current master)

- **G7 / B49 server** — `routes.service.ts`: the `{ id, productId, product, qty, unitPrice,
status }` lineItems select literal exists **three** times: inside `RUN_STOP_INCLUDE` (`:83-92`;
  const `:64-110`, used `:1072` findAllRuns, `:2176` findMyRuns), `findOneRun` main query
  (`:1139-1148`) and its unlinked-orders fallback (`:1245-1254`, branch `:1228`).
  `getRunPackingList`'s fallback (`:2081-2108`) is a narrower include-only shape — NOT in G7.
  None of the copies carries `subtotal`/`boxes`/`pieces`/`unitsPerBox`; `OrderItem` has all four
  (`schema.prisma:1454-1505`, `unitsPerBox` is the sale-time snapshot).
- **B49 client** — four `qty * unitPrice` reducers: `(driver)/route/index.tsx:173-178`,
  `stop/[stopId]/index.tsx:173-178`, `payment.tsx:71-76` (`fullOrderTotal`; `:121-128` only the
  first order gets short-pick `reconciledTotal`, every other order falls back), and
  `return/index.tsx:117-122`. Mobile `RouteRunOrderItem` (`lib/api/routes.ts:17-24`) has no money
  fields beyond qty/unitPrice — the correct figure is not derivable client-side today.
- **B83** — `invoices.service.ts` `recordDeliveryPaymentInTx` now spans **`:4491-4644`** (+90
  after F03); tail `:4643` returns `{applied, invoiceIds, paymentIds}` and **discards
  `remaining`**; the `:4576` early return (zero payable invoices) discards the WHOLE amount.
  Caller `completeWithPayment` (`routes.service.ts:1810-2028`) warn-only block `:1944-1963`.
  Manual-flow contrast (excess → AdvancePayment) at `:5028-5043` (outside our region; reference
  only). Idempotent replay short-circuits pre-tx at `:1846-1850`; key-less replay blocked by the
  already-completed guard `:1833` — an advance write in the tx cannot double-fire.
- **B148** — `RunDeliveryDto` (`complete-stop.dto.ts:18-23`) lacks `productId`; global pipe
  `main.ts:180-186` is `whitelist + forbidNonWhitelisted`; mobile sends `productId` on every
  delivery (`payment.tsx:196-223`; `short-pick.ts:91-107`). Consequence beyond the register:
  both `deliveryMutation.create` sites (`routes.service.ts:1718-1728`, `:1906-1915`) omit
  `productId` while `findOneRun` selects it and `reopenStop` gates stock-restore on it.
- **B152** — `runSettlementStore.ts:20` plain `create()` (RAM-only, self-documented); sole
  settlement entry `route/index.tsx:383-401` (render-gated `!nextStop` at `:363`), gate
  `:289-290`. `updateRunStatus` (`routes.service.ts:1349-1399`) has role + incomplete-stops
  guards only. **The register missed:** `completeStop` (`:1744-1757`) and `completeWithPayment`
  (`:1965-1979`) auto-complete the run in their own tx when the last stop closes (RF-016) —
  bypassing `updateRunStatus` — so on the common path (last stop completed, cash in hand) no
  backstop there can ever fire. The run payload exposes zero collected-payment data (no
  invoicePayment reads in the file outside `reopenStop`'s transaction block).
- **B167** — F01's columns `RouteRun.settlementNote`/`settlementVariance` (schema `:1213-1214`)
  are live in prod and **dead in code** (zero reads/writes). The mobile close flow
  (`settlement.tsx:81-120`) appends the note into `run.notes` via `PATCH :id` then PATCHes
  COMPLETED — two non-transactional calls. Sole `run.notes` renderer is `EditRunModal.tsx:107-116`,
  double-gated (routes list is `activeOnly: true` at `page.tsx:325`; edit hidden `:493-501`).
  A run **detail page exists** (`routes/[id]/page.tsx`, linked `page.tsx:486-492`) and renders no
  notes — the natural read surface. `PATCH :id` (`routes.controller.ts:265-274`) takes an inline
  non-class body → unvalidated today; do not retrofit it.

## Structural facts that scope the fix

- "Cash collected for this run" is derivable with **no new column**: CONFIRMED
  (`CONFIRMED_PAYMENT`, `invoices/payment-predicates.ts:23`) CASH/CHECK `InvoicePayment` via
  `invoice.order.routeRunId` (`Order.routeRunId` persists after completion — pinned by
  `orders.service.spec.ts:2682`; cleared only by deleteRun/deleteRoute), windowed
  `paidAt >= run.startedAt`.
- `AdvancePayment` (`schema.prisma:2731-2750`) is the on-account wallet the manual flow already
  uses; `recordDeliveryPaymentInTx` refuses ADVANCE/CREDIT_NOTE as _methods_ (`:4503-4504`) —
  creating one is orthogonal. Multi-customer stops are anomalous but reachable (DTO-set
  `routeRunStopId`, `orders.service.ts:2169-2177`) → advance must be single-customer-guarded.
- Test seams: `routes.service.spec.ts` builds its own `txMock` and overrides `tenantTransaction`
  (`:1211-1224`) — follow it; `prisma-mock.ts` already proxies `invoicePayment`/`advancePayment`;
  its `tenantTransaction` passthrough is fine here (no tenancy-isolation claims in F05's tests).
  Mobile jest is pure-logic `.ts` only → mobile proofs live in extracted lib helpers.
  `playwright.config.ts` has exactly 22 projects, JSON reporter → `.campaign/runs/web-e2e.json`;
  next spec number 23; copy the `payment-truth` entry pattern (`:317-330`).

## Lane fences

- `orders.service.ts` untouchable (F06/F07). `invoices.service.ts` only `:4491-4657`
  (`updatePayment` starts `:4658` — hard boundary). `getRunPackingList` untouched.
- F05 is FIRST in the routes lane this window; F10/F11/F12/F22 consume the G7 const — name it
  `RUN_LINE_ITEMS_SELECT`, place it directly above `RUN_STOP_INCLUDE`, doc-comment it as G7.
- F10 handoff: with B83 fixed, a post-`reopenStop` re-collection books the ENTIRE second amount
  as an advance (invoices already PAID) — correct money-truth; noted on F10's card at close-out.
