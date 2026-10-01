# G3

## Root cause (≤ 3 lines)

`/buyer/dashboard` returns `recentOrders` items with `itemCount` (a precomputed number), not a `lineItems` array. The buyer home screen called `lastOrder.lineItems.reduce(...)` unconditionally; since `lineItems` is `undefined` on every dashboard response, this threw `TypeError: Cannot read properties of undefined (reading 'reduce')` on mount, crashing the entire buyer home screen.

## RFs addressed

| RF/NEW    | Sev | Status | Files                                                                        | Commit                                                                      | Test added                                                               | Migration? |
| --------- | --- | ------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| NEW-vop-1 | P0  | FIXED  | `apps/mobile/app/(customer)/(tabs)/home.tsx`, `apps/mobile/lib/api/buyer.ts` | fix(buyer): NEW-vop-1 — guard buyer dashboard reduce against undefined data | `apps/mobile/__tests__/buyer-home-dashboard.test.ts` (4 tests, all pass) | No         |

## Notes / blockers

- `DashboardOrder` type added to `lib/api/buyer.ts` to model the minimal shape that `/buyer/dashboard` actually returns (`itemCount?: number`, `lineItems?: Array<...>`). The old `recentOrders: BuyerOrder[]` type was incorrect — `BuyerOrder.lineItems` is required but the API never sends it in the dashboard payload.
- `jest.config.js` added to `apps/mobile` (pure-logic node env, ts-jest preset) so the new test can run with `node ../../node_modules/jest/bin/jest.js`.
- `pnpm typecheck` (`tsc --noEmit`) on `apps/mobile` exits 0.

## User-visible proof of fix

Buyer 2 (or any buyer) landing on the `/home` tab of the mobile customer app now sees the dashboard with correct item counts instead of a blank white screen. Item count displays `lastOrder.itemCount` (returned by the API) with a safe `(lineItems ?? []).reduce(...)` fallback for any future code path that does populate `lineItems`.
