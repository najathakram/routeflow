# Area: mobile (`apps/mobile`)

Expo 55 / RN 0.83, expo-router multi-role app (`(auth)`, `(customer)`, `(driver)`,
`(operator)`, `(tenant)`); mirrors web's API/DTOs/flows, UI-only differences; Socket.IO
real-time sync; offline queue for driver route completions.

**2026-09-03 (wave E / imp-10b):** `lib/api/*.ts` DTOs/enums the sweep found duplicated with web
now import from `@routeflow/types` instead of hand-typing (see [`packages`](packages.md)). Fixed
three real enum drifts this surfaced (L-072): `lib/api/vendor-bills.ts` `VendorBillStatus` had
`"FULL"` (not a real value) and omitted `OVERDUE` — call sites `app/(operator)/(tabs)/finance.tsx`,
`app/(operator)/vendor-bills/{index,[id]}.tsx`; `lib/api/purchase-orders.ts` `POStatus` had
`"PARTIALLY_RECEIVED"` where the schema says `PARTIAL` — this silently hid the Receive action on
`app/(operator)/purchase-orders/[id].tsx` once a PO went partial, and made the `status` list filter
in `useOpenPurchaseOrders` always return zero rows for that leg; `lib/api/buyer.ts`
`BuyerPromotion.type` omitted `"BUY_N_GET_M"` (masked by a compensating `as PromotionType` cast in
`lib/buyer-cart-logic.ts` `matchingBogoPromo`, now removed). Sibling-sweep find: both apps'
`EstimateStatus` carried a phantom `"EXPIRED"` — dead branch removed from `lib/estimates-logic.ts`.

> **2026-09-13 split** (`docs/code-map-split-land`): this file used to hold ALL of mobile's
> signature-level content (313,959 bytes — over 3x the 100,000-byte area cap; its own "Where to
> find" table alone was padded to 165,321 bytes before de-padding). The content below was moved
> verbatim into the part files under `mobile/` (see `_meta.json.notes` for the row-count proof).
> This file is now a table of contents only.

## Module index

| Part                                                   | Covers                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [mobile/where-to-find.md](mobile/where-to-find.md)     | Where to find (this area) — need/symptom → file/symbol                                             |
| [mobile/app-shell-lib.md](mobile/app-shell-lib.md)     | App shell & lib                                                                                    |
| [mobile/screens-by-role.md](mobile/screens-by-role.md) | Screens by role (`app/`): `(auth)`, `(customer)`, `(driver)`, `(operator)`, `(tenant)`             |
| [mobile/tests-1.md](mobile/tests-1.md)                 | Tests (1/2): `__tests__/` intro + batches through 2026-08-25 recurring-routes/order-delivery split |
| [mobile/tests-2.md](mobile/tests-2.md)                 | Tests (2/2): batches from 2026-08-28 `developer_mode` narrowing through 2026-09-09 Train 1/2       |
