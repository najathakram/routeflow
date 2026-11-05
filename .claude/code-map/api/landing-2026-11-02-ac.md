# Api landing 2026-11-02, train ac (merge commit `4b2516c9f2`, range `93282c147c..4b2516c9f2`; train PR #4134, train head `93aa0f65d1`)

Paths under `apps/api/src/` unless they start with `apps/`, `packages/` or `scripts/`. Four members, each merged into the train by its own merge commit: #4128 `9d5fd4c44d` (api + web + types), #4124 `c3f4d03ff5` (api only), #4122 `d6df48af54` (api + web + pricing + types), #4131 `2e74b85665` (docs only: Train z bookkeeping). **No migration** (no `apps/api/prisma/` path in the range), no cron, no plan flag or addon gate, no new env var. Web and shared side: `web/landing-2026-11-02-ac.md`. Train ab (#4133) was void: its Verify failed on `auth/permissions/permission-coverage.spec.ts` because #4128 had no pin row; the row is in `9d5fd4c44d`. Tests are named from the diff and the PR text and were not run for this note.

## #4128 `9d5fd4c44d` credit-notes summary (B238, F10)

Rule: the credit-notes tiles read one server summary over every note, never a client fetch-all that a page cap truncates (the invoices page's B12 shape).

- `credit-notes/credit-note-summary.ts` (new): `computeCreditNoteSummary` reads the whole set with no `take`; returns status counts, open credit and count, issued-in-last-30-days value and count, top reason. "Last 30 days" is anchored on the viewer's own calendar day (`today`, L-047) and counts by `createdAt` (no `issueDate` column). Money goes through `roundMoney`.
- `credit-notes/credit-notes.controller.ts`: `@Get("summary") getSummary(@Query() CreditNoteSummaryDto, @CurrentUser())`, registered before `:id`; `credit-notes.service.ts` `getSummary`; `credit-notes/dto/credit-note-summary.dto.ts` (`today`).
- `auth/permissions/permission-map.pinned.ts`: `CreditNotesController.getSummary` pinned `UNGUARDED`, like `findAll` (the pin that failed train ab).
- Tests: `credit-notes/credit-note-summary.spec.ts` (new, 9 rows), `packages/pricing/src/no-hand-rolled-money-rounding.pin.spec.ts` (percent site moved to the new file).

## #4122 `d6df48af54` live stock per order line (SA-1086 PR-1, row 50)

Rule: a read and a note only. Staff building or editing an order see what is left per line; it never blocks Save and the server still decides at save.

- `orders/stock-availability.ts` (new pure judge), `orders/stock-availability.service.ts` (new, injected into `OrdersController`), `orders/dto/stock-availability-query.dto.ts`: `GET /orders/stock-availability`, OPERATOR and up under ORDERS, above `:id`; one product query per draft, capped at 200 ids; recipe products left out; tenant-scoped via `forTenant()`; `allowOversell` is the save path's own `resolveOversellAllowed` (mode `entry` or `edit`). `orders/orders.module.ts` provides it.
- `orders/orders.controller.ts` gains the required `StockAvailabilityService` constructor arg: five Nest-DI specs got a stub provider and seven construction sites one more argument (`orders.controller.*.spec.ts`, `orders.merge-*.spec.ts`, `orders.scan-hardening.spec.ts`, `messaging/staff-order-email-routes.spec.ts`).
- `orders/line-piece-qty.ts`, `orders/order-stock.ts`: `toPieces`, `linePieceQty`, `sumPiecesByProduct` moved to `@routeflow/pricing` (`stock-pieces.ts`) and re-exported, so save and note count with the same code.
- Pin: `OrdersController.getStockAvailability` → ORDERS in `auth/permissions/permission-map.pinned.ts`.
- Tests: `orders/stock-availability.spec.ts` (8), `orders/stock-availability.controller.spec.ts` (LS-5, LS-6), `packages/pricing/src/stock-pieces.spec.ts` (9). PR-2 (counter row, CQ-13, LS-9) is not in this range.

## #4124 `c3f4d03ff5` run detail fallback keeps delivered history off a live run (B756, first half)

- `routes/routes.service.ts` `findOneRun`: the legacy unlinked-orders fallback excludes DELIVERED as well as CANCELLED unless the run is COMPLETED (a COMPLETED legacy run keeps its delivered orders), matching `getRunPackingList`.
- Tests: `routes/routes.service.run-terminal-release.spec.ts` T7c (live run) and T7d (COMPLETED legacy run). B756 stays open for its "no limit" half; this change adds none.

## #4131

- `2e74b85665`: docs only (`.claude/code-map` landing notes for train z, B1276, B652 and B1265 closures). No source change.
