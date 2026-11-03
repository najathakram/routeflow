# Web landing 2026-11-03, train am (merge commit `06813470de`, range `1f6f32a341..06813470de`; train PR #4171, head `d57a308b89`)

Web paths under `apps/web/` unless they start with `apps/api/` or `packages/`. Three members: #4166 `d68ce0f740`, #4169 `4de22404b4`, #4157 `081b8fcc3e` (api side in `api/landing-2026-11-03-an.md`). No migration, no new env var. Tests are names only; they were not run for this note.

## #4166 `d68ce0f740` the web editor reads a stored line's own pack (SA-1097)

- `lib/line-own-pack.ts` (`lineOwnPack`): the pack a stored line was sold in, gated on `boxes != null OR pieces != null`; used by `app/(dashboard)/orders/[id]/_components/{OrderLineItemCards,OrderLineItemsTable,order-line-edit,unit-line-lock}`; `lib/generic-toast-copy.ts` words the two new error codes.
- Tests: `lib/line-own-pack.test.ts`, `orders/[id]/OrderLineItems.stored-pack.test.tsx`, `order-line-edit.stored-pack.test.tsx`, `page.edit-line-pack-size.test.tsx`, `lib/generic-toast-copy.test.ts`.

## #4157 `081b8fcc3e` the counter's cart rows show the live stock note (SA-1086 PR-2; CQ-13, LS-9)

Rule: the same note New Order shows ("1 box and 8 pieces left", amber when the cart asks for more, red at nothing left). A note only: it never disables Complete and a failed read prints nothing.

- `app/(dashboard)/orders/_components/counter-line-stock.ts`: `stockLineOfSaleLine(line)` builds each line from `toSaleItem(line)` (what the till posts); `useCounterLineStock(lines, customerId)` makes one read for the whole cart in mode `entry` (the staff create path); a walk-in sends no customer id. `CounterLineRow.tsx` takes a `stock` prop and prints `components/LineStockNote.tsx` under the price line; `CounterSaleScreen.tsx` passes it. A boxed line is worded by its pack label.
- `lib/line-stock.ts`, `lib/api/stock-availability.ts`: two missing rows from #4122 (a saved 3 Cases x12 switched to x24 holds 36; with no stored pack there is no honest count).
- Tests: `counter-line-stock.test.ts`, `CounterLineRow.stock.test.tsx`, `CounterSaleScreen.live-stock.test.tsx` (not run locally at merge: `@hookform/resolvers` missing from the stale node_modules; CI ran it), `orders/[id]/edit-line-stock.test.tsx`, `lib/line-stock.test.ts`.

## #4169 `4de22404b4`

- `lib/common-units.plural.test.ts`: runs every `COMMON_UNITS` entry through `plural()` against a pinned expected plural. The fix itself is in `packages/pricing` (see the api note).
