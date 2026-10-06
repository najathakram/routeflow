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

- **`Dockerfile` + `railway.toml` (#712, B389)** — web-export runner is nginx (non-root,
  `nginx-unprivileged:alpine`); watchPatterns `apps/mobile/**` + `packages/**`.

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
| [mobile/landing-2026-09-29-early.md](mobile/landing-2026-09-29-early.md) | Landing 2026-09-29 early (mobile+web): price suffix, buyer bell seller switch, qty width, PO pack labels, applied credits |
| [mobile/landing-2026-09-29-midday.md](mobile/landing-2026-09-29-midday.md) | Landing 2026-09-29 midday (mobile): OTA runtime 1.2.0, ADD_ITEM retry drop (B795), shared PaymentMethod |
| [mobile/landing-2026-09-29-late.md](mobile/landing-2026-09-29-late.md) | Landing 2026-09-29 late (mobile): iOS scan-tray price modal sequencing (B901) |
| [mobile/landing-2026-10-06-w4-w10.md](mobile/landing-2026-10-06-w4-w10.md) | Landing 2026-10-06 (mobile): buyer submit key (B1094), types mock mirrors, B1117 gap |
| [mobile/landing-2026-10-01-w12-w27.md](mobile/landing-2026-10-01-w12-w27.md) | Landing 2026-10-01 (mobile): scan level by code, aim box + Hold to scan, credit-note edit UI, `defaultUnitValue` |
| [mobile/landing-2026-09-30-w9-w11.md](mobile/landing-2026-09-30-w9-w11.md) | Landing 2026-09-30 (mobile): PO receive stored pack (#2781), socket bulk invalidation pins, M3 sub-lines |
| [mobile/landing-2026-09-30-drift-c38f2b0.md](mobile/landing-2026-09-30-drift-c38f2b0.md) | Landing 2026-09-30 (earlier drift, mobile): applied-credit wording, credit createdAt, Google mismatch message |
| [mobile/landing-2026-09-28-late.md](mobile/landing-2026-09-28-late.md) | Landing 2026-09-28 late: buyer custom lines skipped (B889), useNewUi flag, one-unit-sold surfaces, return-only-bought guard |
| [mobile/catchup-2026-09-21.md](mobile/catchup-2026-09-21.md) | Catch-up 2026-09-21: `BlockedLinesModal`, `po-list-logic`, `selling-restricted` |
