# Web landing 2026-11-02, train ac (merge commit `4b2516c9f2`, range `93282c147c..4b2516c9f2`; train PR #4134, train head `93aa0f65d1`)

Web paths under `apps/web/` unless they start with `scripts/`, `apps/api/` or `packages/`. Four members: #4128 `9d5fd4c44d`, #4122 `d6df48af54`, #4124 `c3f4d03ff5` (api only), #4131 `2e74b85665` (docs only). The api side is in `api/landing-2026-11-02-ac.md`. No migration, no new env var, no cron, plan flag or addon gate. Tests are names only; they were not run for this note.

## #4128 `9d5fd4c44d` credit-notes tiles from a server summary (B238)

- `lib/api/credit-notes.ts`: new `useCreditNoteSummary(today)`, keyed under `["credit-notes"]` so every mutation that invalidates that prefix refreshes it.
- `app/(dashboard)/credit-notes/page.tsx`: the `useCreditNotes({ limit: 999 })` fetch-all and the client reductions are gone (net -77 lines); counters and money tiles read the summary.
- `packages/types/api/credit-notes.ts`: `CreditNoteSummary`, shared with mobile.
- Tests: `lib/api/credit-notes.summary.test.tsx`, `app/(dashboard)/credit-notes/page.summary-b238.static.test.ts`.

## #4122 `d6df48af54` live stock note under each order line (SA-1086 PR-1)

- `lib/line-stock.ts` (new): judges per product (two lines of one product are summed, B920); on edit it counts only the increase over the saved lines under each line's original product; negative stock reads as 0 left; a named-unit line counts as count x the unit's factor and says what is left in its own words; on a draft every line counts whole; nothing honest to show means no note. Wording is in `LINE_STOCK_WORDS`.
- `lib/api/stock-availability.ts` (new): the read hook for `GET /orders/stock-availability`. `components/LineStockNote.tsx` (new) renders under the row in `components/LineItemRow.tsx`; wired into `app/(dashboard)/orders/_components/CreateOrderModal.tsx` and the edit builder (`orders/[id]/_components/order-line-edit.tsx`, `orders/[id]/edit-line-stock.ts`, `orders/[id]/page.tsx`). `lib/default-unit-line.ts` and `lib/order-line-unit.ts` carry the unit factor (`unitFactor`) on the line.
- `packages/types/api/stock-availability.ts` (new): `StockAvailability`, `StockAvailabilityItem`. Buyers stay out (SA-714).
- Tests: `lib/line-stock.test.ts` (17), `orders/[id]/edit-line-stock.test.tsx` (13), `CreateOrderModal.live-stock.test.tsx` (5), `lib/api/stock-availability.unit-line.test.ts` (2).

## #4124, #4131

- #4124 `c3f4d03ff5`: api only. #4131 `2e74b85665`: docs only (train z bookkeeping).
