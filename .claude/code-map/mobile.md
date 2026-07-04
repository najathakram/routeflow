# Area: mobile (`apps/mobile`)

Expo 55 / RN 0.83, expo-router multi-role app (`(auth)`, `(customer)`, `(driver)`,
`(operator)`, `(tenant)`); mirrors web's API/DTOs/flows, UI-only differences; Socket.IO
real-time sync; offline queue for driver route completions.

## Where to find (this area)

| Need                             | File → symbol                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API base client, token handling  | `lib/api-client.ts` — `apiClient` axios, `BASE_URL` via `EXPO_PUBLIC_API_URL`, role-namespaced tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Auth login & token refresh       | `lib/auth.ts` — `login()`, `loginWithGoogle()`, `getStoredUser()`, `refreshTokens()`, SecureStore (web → localStorage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Operator/driver auth store       | `lib/auth-store.ts` — `useAuthStore` (Zustand), dual-role, activeRole override                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Buyer auth & session             | `lib/buyer-auth.ts` + `lib/buyer-session-store.ts` — login, activeSeller, cross-tab logout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Socket.IO operator/driver        | `hooks/useSocket.ts` — order/route/stop events → query invalidation, transports [polling, websocket]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Socket.IO buyer                  | `hooks/useBuyerSocket.ts` — buyer-namespaced socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Offline queue (driver)           | `hooks/useNetworkSync.ts` + `store/offlineQueue.ts` — route-stop completion queue, retry, drop if run cancelled                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Routes (driver)                  | `lib/api/routes.ts` — `useActiveRouteRun`, `useScheduledRouteRuns`, `useOptimizeRouteRun`, `useUpdateRunStatus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Orders (all roles)               | `lib/api/orders.ts` — Order + OrderStatus, customer cart mutation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Invoices                         | `lib/api/invoices.ts` — InvoiceStatus, payments, recordPayment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Returns                          | `lib/api/returns.ts` — ReturnReason, ReturnStatus, item-level restock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Customers / products / inventory | `lib/api/{customers,products,inventory}.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Pricing / money                  | `lib/pricing.ts` — `getTierPrice`, `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney` (mirror of API `common/pricing.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Operator order/invoice scan      | `components/NewOrderScreen.tsx` (CartModal/CartRow) + `app/(operator)/(tabs)/invoices/new.tsx` (ReviewSheet) — per-line editable price (the "discounted price"); `LineState.unitPrice?` override sent as the line `unitPrice` (orders only below catalog); `useCustomerPriceHistory(customerId)` pre-fills the price from the customer's last given price on scan; CartRow shows "Current: $X" when overridden, "Last: $X" hint when history exists but no override. **Both screens auto-scroll the scanned product row into view** (ScrollView ref + per-row `onLayout` offset map). |
| Integer qty input                | `lib/qty.ts` — `sanitizeIntInput`/`parseIntQty` (no decimals/leading zeros); used by order/invoice qty steppers                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Share a PDF (no download)        | `lib/share-pdf.ts` — `sharePdf()`: web → `navigator.share({files})`, native → cache + `expo-sharing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Barcode scanner                  | `components/BarcodeScanner.tsx` (native, expo-camera) + `BarcodeScanner.web.tsx` (`@zxing/browser` + getUserMedia rear-cam, friendly errors)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Deep-link scheme                 | `app.json` — scheme `routeflow`, slug `routeflow-mobile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## App shell & lib

- root `app/_layout.tsx` — Gesture + SafeArea + QueryClient + fonts + Notifications + auth/tenant/buyer init gates + ConfirmModal.
- **API client** `lib/api-client.ts` — axios base, 15s timeout, `getActiveAccessToken()` respects role-namespaced keys (`rf:op:accessToken`, `rf:driver:accessToken`, ...).
- **auth / secure storage** `lib/auth.ts` — SecureStore native / localStorage web, token refresh with 401-retry.
- **tenant branding** `lib/tenant-store.ts` — slug, businessName, primaryColor, logoKey (persistent Zustand).
- **location tracker** `lib/location-tracker.ts` (+ `.web.ts`) — driver background location.
- **stores** `store/{cartStore,mileageStore,podStore,routeStore,productPickerStore,offlineQueue}.ts`.

## Screens by role (`app/`)

### `(auth)/`

- `login.tsx` (username/password + Google + tenant slug), `sign-in.tsx` (entry decision),
  `role-picker.tsx` (operator vs driver), `company-code.tsx` (tenant lookup),
  `customer-login.tsx` (buyer), `google-callback.tsx`, `force-change-password.tsx`,
  `forgot-password.tsx`, `reset-password.tsx`, `operator-blocked.tsx`.

### `(customer)/` — buyer app

- root `_layout.tsx` — Stack, `useBuyerSocket()`, buyer/activeSeller gate.
- tabs `(tabs)/_layout.tsx` — Home, Orders, Catalog, Invoices, More.
- `(tabs)/home.tsx` (dashboard, recentOrders w/ itemCount fallback, balance), `orders.tsx`,
  `catalog.tsx` (tier pricing), `invoices.tsx`, `more.tsx`.
- `profile.tsx`, `orders/[id].tsx` (detail, cancel), `orders/[id]/edit-items.tsx` (DRAFT qty),
  `orders/cart.tsx` (checkout → `POST /buyer/orders`), `invoices/[id].tsx` (record-payment, **Share PDF** when `pdfUrl` present),
  `change-password.tsx`, `standing-orders.tsx` (recurring calendar).

### `(driver)/` — tabs: Route, Map, Orders, Menu

- root `_layout.tsx` — Tabs, `useSocket()`, OfflineBanner.
- `route/index.tsx` (active run, stop list, optimize, complete-route),
  `route/stop/[stopId]/` → `index.tsx` (detail + delivery mutations), `photo.tsx` (POD →
  `podPhotoUrls[]`), `signature.tsx`, `payment.tsx` (cash), `note.tsx`, `return/index.tsx`,
  `new-order.tsx`, `split-invoice.tsx` (partial delivery).
- `map.tsx` (route map, live position, openInMaps), `orders.tsx`, `driver-profile.tsx`,
  `driver-menu.tsx`, `driver-messages.tsx`, `driver-change-password.tsx`, `driver-new-order.tsx`, `cash.tsx`.

### `(operator)/` — tabs: Home, Dispatch, Orders, Warehouse, Finance, More

- root `_layout.tsx` — Stack, `useSocket()`, OfflineBanner. tabs `(tabs)/_layout.tsx` (popTabToRoot on re-press).
- `(tabs)/home.tsx` (KPIs), `dispatch.tsx` (routes calendar, driver assign), `warehouse.tsx` (+ inventory-value KPI w/ missing-cost count via `useInventoryValuation`), `finance.tsx`, `more.tsx`.
- **Cost basis (mirrors web):** `products/[id]/set-cost.tsx` (audited COST_BASIS via PATCH /inventory/products/:id/cost-basis); product detail shows effective cost (standardCost ?? averageCost) w/ "No cost set" chip; vendor-bill receive sends `{id, acknowledgeUnlinked?}` + native confirm on UNLINKED_ITEMS 409 (`getUnlinkedItemsError`/`billNeedsMapping` in `lib/api/vendor-bills.ts`); `movements.tsx` renders COST_BASIS rows (shows set cost, not qty).
- **Tobacco (addon-gated, mirrors web):** `tobacco/index.tsx` — KPIs, report list (PDF share via `sharePdf`), generate last month, flagged inventory; conditional More-menu row + product detail mark/unmark action, all gated on `useHasAddon("tobacco_dealer")` (`lib/api/tobacco.ts`).
- `(tabs)/orders/` → index (status filter), `[id].tsx` (assign driver, split-invoice; **"Edit items" entry shown for DRAFT/PENDING/CONFIRMED** — mirrors API guard), `[id]/edit-items.tsx` (integer-qty stepper; `PriceOverrideModal` new-price **+ "Amount off / unit"** lens, **price edit on DRAFT/PENDING/CONFIRMED** (gated by `canEditPrice`; was DRAFT-only) — read-only on terminal statuses; fresh adds pre-fill remembered price via `useCustomerPriceHistory`), `[id]/split-invoice.tsx`.
- `(tabs)/invoices/` → index (status), `[id].tsx` (payments, write-off, **Share PDF → `sharePdf()` direct share**), `[id]/record-payment.tsx`, `create.tsx`, `new.tsx`.
- `customers/` → index, `[id].tsx`, `[id]/edit.tsx`, `[id]/addresses.tsx`, `[id]/catalog.tsx` (per-customer tier pricing), `new.tsx`/`create.tsx`.
- `drivers/` → index, `[id].tsx`, `[id]/edit.tsx`, `new.tsx`/`add.tsx`.
- `products/` → index (barcode lookup), `[id].tsx`, `[id]/adjust-stock.tsx`, `new.tsx`/`create.tsx`, `adjust-picker.tsx`.
- `returns/`, `routes/`, `purchase-orders/` (Stack layouts); `new-order.tsx`, `pick.tsx` (pick-list),
  `exceptions.tsx`, `analytics/index.tsx`, `movements.tsx`, `messages.tsx`, `fleet.tsx`, `driver.tsx`,
  `profile.tsx`, `change-password.tsx`, `expenses/{index,[id],new}.tsx`.

### `(tenant)/` — tenant-admin dashboard

- root `_layout.tsx` — Tabs (Today, Dispatch, Billing, Settings, More). Operator-like scope with org-level controls.

## Tests (`__tests__/`)

- `socket-wiring.test.ts` — role-namespaced token reads, Socket.IO init, transport order [polling, websocket].
- `buyer-home-dashboard.test.ts` — guards undefined `lineItems`, falls back to `itemCount`.
- `operator-create-forms.test.ts` — form validation (new customer/driver/product/order).
- `qty.test.ts` — `sanitizeIntInput`/`parseIntQty` (integer qty: no decimals/leading zeros).
- `pricing.test.ts` — money mirror (`computeLineSubtotal`/`roundMoney`/`normalizeBoxesPieces`) agrees with server.
- mocks: `@routeflow/ui.js`, `@routeflow/types.js`, `expo-secure-store.js`.
