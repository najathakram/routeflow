# Api landing 2026-10-26, train 4c (#3833 `be16a6b43`, #3821 `575bbdbb6`, #3767 `8f154e10c`, #3844 `52245384f`, #3760 `4a96538fb`; merge `b1a2fc3d1`, PR #3852)

Paths under `apps/api/src/` unless noted. Tests not indexed. Web part: `web/landing-2026-10-26-train4c.md`. #3813 is web only. #3797 and #3845 were ejected from train 4 (census red) and are NOT here.

## #3833 `be16a6b43` sweepAllPendingOrders lifted out of orders.service.ts (size-ratchet prefactor)
- New `orders/order-sweep.ts`: `sweepAllPendingOrdersImpl(self: OrdersService)`; imports `isMergeContention`, `openTenantGroups`. `OrdersService.sweepAllPendingOrders` delegates. Behaviour unchanged.
- `common/size-ratchet.spec.ts`: orders.service.ts baseline 5273 -> 5192 (after #3821: 5200 lines). Adjacent baseline lines collide with any PR that edits the invoices line, so rebase size-ratchet PRs after this.

## #3821 `575bbdbb6` strike off a delivered line on DELETE; pin saved override pack price (rows 307, 516)
- `orders/orders.service.ts` `updateOrderItems`: a line is kept (struck off, never deleted) when `invoicedQty > 0` OR the line's own `deliveredQty > 0` OR any `deliveryMutation` exists. A manual DELIVERED, counter sale or pickup stamps `deliveredQty` with no mutation row, so mutation rows alone were not enough. A struck-off line stays booked at what left; returned goods are a return, never an edit.
- Saved override pack price is pinned on re-save (row 516).

## #3767 `8f154e10c` restriction copy names the business's reason, not a law (W-806)
- `selling-restrictions/restriction-warning.ts`, `staff-breaches.ts`: breach copy built from the rule's reason; `no-by-law-copy.pin.spec.ts` pins that no "by law" wording ships. Types in `packages/types/api/restrictions*.ts`.

## #3844 `52245384f` addon gate review clock pinned (W-958)
- `billing/addon-gate-registry.spec.ts` only: `REVIEW_AS_OF = "2026-10-26"` replaces "today" so the dark-row `reviewBy` check cannot go red on a calendar date. The nag belongs to the ops monitor. Bump it deliberately when a row is reviewed.

## #3760 `4a96538fb` Mac visibility timer (W-910) - outside the mapped areas
- `scripts/visibility-timer.mjs`, `scripts/lib/visibility-window.mjs` (`buildMarker`, `parseMarker`, `decide`; marker `ops/visibility-window.json`, grace 2 min, stale 6 h, max window 4 h), `scripts/visibility-watchdog.mjs` `--window-marker`, `tools/visibility-timer/` (launchd plist, README), `docs/runbooks/deploy-visibility-flip.md`. Specs live under `common/visibility-*.spec.ts`.
