## 3. Driver App — (driver)

**Role(s):** Delivery drivers (JWT role `DRIVER`; an OPERATOR/TENANT_ADMIN can also land here after a "Switch role" toggle). All data is tenant-scoped via the JWT `tenantId`/`role`. • **Entered via:** The `(driver)` route group's bottom tab bar (`Route`, `Map`, `Orders`, `Cash`, `More`); hidden screens are reached from the More menu or via `router.push`; the per-stop delivery flow is reached by tapping a stop card on the Route tab.

This is the on-the-road delivery experience: it drives the day's run through a state machine (no route → start of day → active run → done), captures proof-of-delivery (photo / signature / note), collects payment, records partial returns/credits, splits an order into invoices, creates ad-hoc orders, and streams GPS to the operator's live map. A persistent offline banner + queue lets stop-completions survive a network blip. Note that several tabs (Cash, Messages) are honest "coming soon" placeholders — no backend exists yet.

### Screens

#### Driver tab shell — `/(driver)/_layout.tsx`

- **File:** `apps/mobile/app/(driver)/_layout.tsx`
- **Purpose:** Hosts the 5-tab bottom bar (`IosTabBar`), a global offline banner, and the real-time socket subscription for the whole driver group.
- **Shows:** Tabs `Route` (git-branch icon), `Map` (map icon), `Orders` (list icon), `Cash` (cash icon), `More` (ellipsis). An **offline banner** across the top when disconnected: cloud-offline icon + "Offline" and, when the queue is non-empty, "— N action(s) queued".
- **Actions:** Tab presses switch tabs; `useSocket()` keeps the app subscribed to route/stop events so operator dispatches land without a manual refresh (RF-002). Hidden stacks registered with `href: null`: `driver-messages`, `driver-profile`, `driver-change-password`, `driver-new-order` (driver-prefixed filenames avoid URL collision with the operator group).
- **States:** offline (banner via `useNetworkSync` → `isOnline`, `queueLength`); otherwise chrome only.

#### Route (Today) — `/(driver)/route`

- **File:** `apps/mobile/app/(driver)/route/index.tsx`
- **Purpose:** The home of the run — one screen that renders one of four states depending on the driver's route runs.
- **Shows / States (run state machine):**
  1. **Loading:** `NavBar largeTitle "Today"` + spinner while `useActiveRouteRun` + `useScheduledRouteRuns` load.
  2. **No route (`NoRoute`):** empty state — map icon, "No route assigned", subtitle pointing to dispatch, and a primary **"Create ad-hoc order"** button → `/(driver)/driver-new-order`.
  3. **Start of day (`StartOfDay`, a SCHEDULED run exists):** `NavBar` "Good morning, {FirstName}" + initials avatar; date eyebrow (locale-safe parse of `scheduledDate`, NEW-rweb-7). Gradient **hero card**: route name eyebrow, "{n} stops · ${totalValue}", "Scheduled · ready to depart". A checkbox **"Optimize from my current location"** (default on). Buttons: **"Start day"** and (if stops exist) **"Maps"**.
  4. **Active run (`TodaysRoute`, an IN_PROGRESS run exists):** `NavBar` "Today's Route" with `On route` green pill + route-name gray pill. `InlineStats`: **Stops / Done / Left** counts; a `ProgressTrack` bar + `{pct}%`. Then either an **"Up next"** gradient card (next stop's number badge, business name, `formatStopSub` = address line1 · N items) or, when no pending stop, a green **"All stops done!"** card ("{done} of {total} delivered"). Below, a **Stops** list of `StopCard`s (number, business name, subtitle, status done/next/pending, pill "Delivered"/"Skipped"/"Up next").
- **Actions:**
  - "Optimize from my current location" toggle → local state; on Start, if on, reads GPS and calls `useOptimizeRouteRun` → `POST /route-runs/:id/optimize` `{originLat,originLng}` before starting.
  - **"Start day"** → `useUpdateRunStatus` → `PATCH /route-runs/:id/status {status:"IN_PROGRESS"}`, then `startLocationTracking(runId)`. Button label cycles "Optimizing…" / "Starting…" / "Start day".
  - **"Maps"** → `openRouteFromHere(stops)` → device Google/Apple Maps with the driver's GPS origin + remaining stops.
  - **"Open stop"** (Up next card) or any `StopCard` → `router.push('/(driver)/route/stop/:id')`.
  - **"Re-optimize from here"** (active card) → reads GPS, `useOptimizeRouteRun`; toasts if location denied.
  - **"Mark route complete"** (all-done card) → `confirm(...)` → `useUpdateRunStatus {status:"COMPLETED"}` ("This will mark the run as finished and lock all stops.").
- **Side effect:** `useEffect` starts `startLocationTracking(active.id)` when an active run appears and `stopLocationTracking()` when it disappears (completed/cancelled).

#### Map — `/(driver)/map`

- **File:** `apps/mobile/app/(driver)/map.tsx`
- **Purpose:** Live map of the active run's stops plus the driver's own position.
- **Shows:** `AppMapView` with pins + a brand polyline through stop coordinates. Pins: **"My location"** (brand, from foreground GPS watch), and one per stop colored by state — gray = COMPLETED, orange = current (first PENDING/IN_PROGRESS), green = other pending. Pin title = business name, subtitle = "Stop {n}". Auto `fitToPins`.
- **Actions:** None interactive beyond the native map; a `watchPositionAsync` (Balanced, 5 s / 25 m) keeps the "My location" pin fresh without waiting for the 30 s/50 m background post.
- **States:** loading (spinner); **empty** (`IosEmptyState` "No active route" — "Your current route stops will appear here once your run is in progress."); web = no foreground GPS pin.

#### Orders (My orders) — `/(driver)/orders`

- **File:** `apps/mobile/app/(driver)/orders.tsx`
- **Purpose:** Read-only list of the driver's own orders, filterable and searchable.
- **Shows:** `NavBar` "My orders"; `SearchBar`; `FilterChipRow` — **Active** (OUT_FOR_DELIVERY, default), **Confirmed**, **Delivered**, **All**. Each `OrderRow`: `orderNumber`, `Urgent` red pill (if `urgent`), customer businessName, "{n} items", a status pill (Pending orange / Confirmed brand / Out for delivery brand / Delivered green / Cancelled red), and `total` formatted as currency.
- **Actions:** Search filters locally by orderNumber/customer; chip sets status; **pull-to-refresh** via `RefreshControl`. Data: `useMyOrders({status, limit:50})` → `GET /orders`. Rows are display-only (no navigation).
- **States:** loading (spinner); **empty** (cube icon — "No orders" / "No orders match your search." or "No orders in this status."); pull-to-refresh (`isFetching && !isLoading`).

#### Cash up — `/(driver)/cash`

- **File:** `apps/mobile/app/(driver)/cash.tsx`
- **Purpose:** Placeholder for end-of-day reconciliation.
- **Shows:** `NavBar` "Cash up" / inline "End of day"; `IosEmptyState` wallet icon — **"End-of-day cash-up is coming soon"** / "You'll reconcile cash, cheques and card totals against your manifest here once dispatch turns it on for your depot."
- **Actions / States:** None — no `/driver/cash-up` endpoint or denomination schema exists yet (deliberate honest empty state, not the demo mockup).

#### More (driver menu) — `/(driver)/driver-menu`

- **File:** `apps/mobile/app/(driver)/driver-menu.tsx`
- **Purpose:** Account hub / role switch / sign-out.
- **Shows:** Identity row (initials avatar, `user.username`, "Driver · {tenantName}"). Grouped `ListRow`s: **COMMUNICATION** → "Messages" ("Dispatch & drivers"); **ACCOUNT** → "Profile", "Change password", "Switch role" ("Go to operator view"); a final **"Sign out"** row.
- **Actions:** Messages → `/(driver)/driver-messages`; Profile → `/(driver)/driver-profile`; Change password → `/(driver)/driver-change-password`; **Switch role** → `setActiveRole("operator")` + `router.replace('/(operator)/home')`; **Sign out** → `logout()`.
- **States:** static (no loading/error).

#### Messages — `/(driver)/driver-messages`

- **File:** `apps/mobile/app/(driver)/driver-messages.tsx` (re-exports `components/MessagesScreen.tsx`)
- **Purpose:** Placeholder for dispatcher↔driver messaging.
- **Shows:** `NavBar` "Messages" with back-to-"More"; `IosEmptyState` chat icon — **"Messaging is coming soon"** / "You'll coordinate with dispatch and other drivers from here once in-app messaging is enabled."
- **Actions / States:** Back only — no `/messages` endpoint or socket feed wired.

#### Profile — `/(driver)/driver-profile`

- **File:** `apps/mobile/app/(driver)/driver-profile.tsx`
- **Purpose:** Read-only account details.
- **Shows:** Avatar block (initials, `username`, "Driver · {tenantName}"). **ACCOUNT**: Username = username, Role = "Driver". **SETTINGS**: "Change password" row. A "Sign out" row. Footer "RouteFlow v1.0.0".
- **Actions:** Change password → `/(driver)/driver-change-password`; Sign out → `logout()`; back → "More".
- **States:** static.

#### Change password — `/(driver)/driver-change-password`

- **File:** `apps/mobile/app/(driver)/driver-change-password.tsx`
- **Purpose:** Self-service password change.
- **Shows:** Three `MobileInput` (secure): **Current Password**, **New Password**, **Confirm New Password**; **"Update Password"** button. Success green banner "Password updated successfully!"; inline API error text.
- **Actions:** `handleSubmit` → `changePassword(current, new)`; on success resets form, shows banner, `router.back()` after 1.8 s.
- **States:** validating (zod), submitting (button `loading`), success banner, error text. **Validation rules:** new password ≥ 8 chars, ≥ 1 uppercase, ≥ 1 digit; confirm must match.

#### Ad-hoc new order — `/(driver)/driver-new-order`

- **File:** `apps/mobile/app/(driver)/driver-new-order.tsx` (thin wrapper → `components/NewOrderScreen.tsx`, `backLabel="Route"`, no stop context)
- **Purpose:** Create a walk-in order with no route/stop link.
- **Shows / Steps (shared `NewOrderScreen`, two phases):**
  1. **Choose customer** — `SearchBar` + list of `useAdminCustomers` (avatar, businessName, contact/phone). Locked and skipped when a `customerId` is supplied (stop-scoped variant).
  2. **New order (product pick)** — customer chip (tap "Change" when unlocked), `SearchBar` with a **barcode** trailing icon, category chips, **"Add unlisted item"** CTA, and a product list. Each product row: image placeholder, name (`Parent - Variant` when applicable), meta "SKU … · $price / box of N | / unit", and a `+`/stepper. Boxed products (unitsPerBox > 1) expand to dual **Boxes** / **Loose pcs** mini-steppers. A floating draggable `BarcodeFab`. Sticky footer: item count + running total, **"View / edit"** (opens Cart sheet), **"Confirm"**.
  - **Cart sheet (`CartModal`):** per-line editable **Price** (one-time override — shows "Current: $x" or "Last: $x" from price history), Boxes/Loose or Qty steppers, remove, unlisted rows tagged "Custom", "Save order".
- **Actions:** `useCreateOrderAsDriver` → `POST /orders` `{customerId, items, routeRunId?, routeRunStopId?, mergeChoice?}`. Barcode → local match then `resolveProductByCode` server fallback; unmatched offers "Create product" (operator/admin only) prefilled with the code. If the customer has an open draft/pending order (`useActiveOrderForCustomer` → `GET /orders/active`), a **Merge / Create separate** dialog appears (also on 409 `MERGE_CHOICE_REQUIRED`).
- **States:** customer-loading, product-loading, empty ("No products…"), saving ("Saving…"), merge-prompt, barcode-not-found.

#### Stop detail — `/(driver)/route/stop/[stopId]`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`
- **Purpose:** The delivery cockpit for a single stop — customer, items, POD tiles, and the paths out (skip / return / split / complete).
- **Shows:** `NavBar` "Stop {stopNumber} / {total}" with back-to-Route + a **"Call"** action. Customer card: gradient initials avatar, businessName, full address, pills "{n} items" and (if > 0) "${total} due". Quick actions: **Call / Text / Directions**. **Items** section — each line: a check circle (green filled when line `status==DELIVERED`), product name, "Short" orange pill (PARTIAL/REFUSED), qty badge "×N". **Proof of delivery** — three `PodTile`s reading the in-memory `usePodStore`: **Photo** (shows "Photo · N" and highlights when captured), **Signature** ("Signature ✓"), **Note** ("Note ✓").
- **Actions:**
  - Call → `tel:`, Text → `sms:`, Directions → `openInMaps({address, lat, lng, label})` (passes business name so Maps matches the place listing). All toast if phone/address missing.
  - Photo tile → `/route/stop/:id/photo`; Signature → `/signature`; Note → `/note`.
  - **"Skip stop"** → `confirm(...)` (destructive) → currently just `router.replace('/(driver)/route')` (no status write here).
  - **"Partial return"** → `/route/stop/:id/return`.
  - **"Split into invoices…"** → `/route/stop/:id/split-invoice`.
  - **"Complete & collect →"** → `/route/stop/:id/payment`.
- **States:** loading (spinner); **not found** (alert icon — "Stop not found" / "It may have been removed from your route."); empty items ("No items scheduled for this stop."). Data: `useRouteRun(runId)` where `runId` comes from the URL or `useActiveRouteRun`. `items` is memoized (NEW-m1-1: avoids React error #185 on DELIVERED stops).

#### Proof photos — `/(driver)/route/stop/[stopId]/photo`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/photo.tsx`
- **Purpose:** Capture up to 3 delivery photos into the POD scratchpad.
- **Shows:** Help text ("Capture up to 3 photos … attached to this stop when you complete it."); `PhotoCapture` grid (add/remove, `maxPhotos={3}`). Footer: **Cancel** / **Save photos**.
- **Actions:** Save → `usePodStore.setPhotos(stopId, photos)` then `router.replace` back to the stop. Not uploaded here — folded into the completion payload later.
- **States:** local only; no network.

#### Customer signature — `/(driver)/route/stop/[stopId]/signature`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/signature.tsx`
- **Purpose:** Capture a customer signature into the POD scratchpad.
- **Shows:** Help ("Hand the device to the customer and ask them to sign confirming receipt."); `SignaturePad`. Footer: **Cancel** / **Save** (disabled until a signature exists).
- **Actions:** Save → `usePodStore.setSignature(stopId, sigUri)` → back to stop.
- **States:** Save disabled (opacity 0.5) with no capture.

#### Driver note — `/(driver)/route/stop/[stopId]/note`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/note.tsx`
- **Purpose:** Free-text note for ops into the POD scratchpad.
- **Shows:** Help ("Anything operations should know … left at side door, customer not home, etc."); multiline `FormTextInput` (6 lines). Footer: **Cancel** / **Save note**.
- **Actions:** Save → `usePodStore.setNote(stopId, text.trim())` → back to stop.
- **States:** local only.

#### Collect payment — `/(driver)/route/stop/[stopId]/payment`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`
- **Purpose:** The atomic "close the stop" screen — collect payment and complete the delivery in one write.
- **Shows:** `NavBar` "Collect payment" (back "Stop", **"Skip"** action = go back). Big invoice total ("$whole.fraction") under an eyebrow "ORDER {orderNumber} · {CUSTOMER}". `SegmentedControl` methods **Cash / Card / Cheque / On account**. Received block: "{METHOD} RECEIVED $x" and a green **CHANGE** box (`max(0, received - total)`). Quick-tender grid (½×total, total, +$20, +$50). A 12-key numeric keypad (`· 0 ⌫`). Inline red error box when validation fails.
- **Actions:** **"Receive payment & close"** (or "Mark on account & close" for On account) → `useCompleteWithPayment` → `POST /route-runs/:runId/stops/:stopId/complete-with-payment` with an **Idempotency-Key** header (BUG-DRV1-3), body `{deliveries, podPhotoUrls, signatureUrl, driverNote, payment?}`. Deliveries built from every line item as `DELIVERED` with integer `quantityDelivered` (`Math.round`). Payment attached only when the order has an `invoiceId` and collected > 0; method mapped Cash→CASH, Card→CREDIT_CARD, Cheque→CHECK, On account→ADVANCE. On success clears the POD store, toasts "Stop completed", and (native, when stops remain) offers an **"Open Maps"/"Stay in app"** alert to relaunch Google Maps with the remaining route; then `router.replace('/(driver)/route')`.
- **States:** loading (spinner); submitting ("Closing…", button disabled); **validation errors** — physical methods (Cash/Card/Cheque) require a non-zero amount (RF-006); at least one delivery item required (NEW-m1-3). POD from `usePodStore` is merged automatically.
- **Business rules:** `collected = min(received, invoiceTotal)` (never overpay the invoice); On account collects $0 but still completes. Atomic complete+payment (RF-005) prevents an orphaned completed stop without a payment.

#### Return & credit — `/(driver)/route/stop/[stopId]/return`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx`
- **Purpose:** Issue a return/credit note for partial or refused items at a stop.
- **Shows:** `NavBar` "Return & credit" with an **"Issue"** action. Header: undo icon, customer name, "Order {n} · ${originalTotal} originally". **Returned items** list built from `stop.deliveryMutations` where type is PARTIAL/REFUSED — each: trash icon, product name, "−${amount}", "× {qty} · {reason}". **Add reason** chip row: Damaged / Expired / Wrong SKU / Short-dated / Customer refused / Quality (single-select). A gradient **CREDIT NOTE** card "−${creditTotal}" / "Will apply to next invoice · {customer}" when > 0. **"Submit return"** button.
- **Actions:** Issue/Submit → `useCreateReturn` → `POST /returns` `{orderId, reason, items:[{productId, qty (rounded int), reason}]}`. Reason label mapped to the API enum (`reasonForApi`: Damaged→DAMAGED, Expired/Short-dated/Quality→QUALITY_ISSUE, Wrong SKU→WRONG_ITEM, Customer refused→CUSTOMER_REFUSED). On success toasts "Return submitted" and returns to the stop.
- **States:** loading (spinner); **empty** ("No partial / refused items flagged for this stop yet."); submitting ("Submitting…", button + nav action disabled). Toasts if no order on the stop or no flagged items.

#### Stop new order — `/(driver)/route/stop/[stopId]/new-order`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/new-order.tsx` (wrapper → `NewOrderScreen`)
- **Purpose:** Add an order at this stop, auto-linked to the run + stop.
- **Shows:** Same `NewOrderScreen` as ad-hoc, but customer is **locked** from the stop (`customerId`, `customerName`), `backLabel` = business name.
- **Actions:** Same product-pick/cart/save flow; `POST /orders` includes `routeRunId` + `routeRunStopId` so the order attaches to the run/stop.
- **States:** loading (spinner while stop resolves), then delegates to `NewOrderScreen` states.

#### Split invoice — `/(driver)/route/stop/[stopId]/split-invoice`

- **File:** `apps/mobile/app/(driver)/route/stop/[stopId]/split-invoice.tsx` (order-picker → shared `components/SplitInvoiceScreen.tsx`)
- **Purpose:** Split a stop's order into N partial invoices, each with its own terms/due date.
- **Shows / Steps:**
  1. **Order picker** (no `orderId`): "Pick the order you want to split…"; each order row = orderNumber, "{n} lines · {remaining} items left to invoice". Empty → "No orders at this stop."
  2. **Composer** (`SplitInvoiceScreen`, with `orderId`): one or more **Invoice** draft cards. Per billable item: name, "{globalLeft} of {totalRemaining} {unit} left · $price/ea", a qty input, and **None / Half / All** quick buttons; a live line total. Per-draft footer: **Terms** pills (Due on Receipt / Net 15 / 30 / 45 / 60), **Due date** (YYYY-MM-DD), **"Send immediately on create"** checkbox, and invoice subtotal. **"Add another invoice"**, an "Not yet allocated" tally, and a bottom **"Create N invoices"** action.
- **Actions:** `useCreatePartialInvoiceFromOrder` → `POST /invoices/from-order/:orderId/partial` `{items:[{orderItemId, qty}], terms, dueDate, send}` — issued **sequentially per draft** (so server-side `invoicedQty` increments don't race). First failure stops the loop; already-created drafts show a "Created" badge and are skipped on retry.
- **States:** loading (spinner); **order not found**; **all invoiced** ("All items invoiced" — to re-split, void/delete an existing invoice); bulk-pending overlay ("Creating…"). Allocations clamp to `qty − invoicedQty` across drafts.

### Key flows (end-to-end journeys through this area)

- **Full delivery (happy path):** Route (StartOfDay) → tap **Start day** (`PATCH …/status IN_PROGRESS`, GPS optimize + tracking begins) → tap next stop → **Stop detail** → capture **Photo/Signature/Note** (each saved to `usePodStore`) → **Complete & collect** → **Payment** (pick method, enter amount) → **Receive payment & close** (`POST …/complete-with-payment` with Idempotency-Key, POD folded in) → POD cleared, "Open Maps?" prompt → back to Route with progress advanced. When the last stop closes → **Mark route complete** (`PATCH …/status COMPLETED`).
- **Partial delivery / return:** Stop detail → **Partial return** → Return & credit (rows from `deliveryMutations`, pick reason) → **Submit return** (`POST /returns`) → credit note applied to next invoice → back to stop → finish via Payment.
- **Split then complete:** Stop detail → **Split into invoices…** → pick order → allocate items across N drafts → **Create N invoices** (`POST /invoices/from-order/:id/partial` each) → back to stop; the completion auto-invoice then sees fully-invoiced items and skips.
- **Walk-in / add-on order:** No route → **Create ad-hoc order** (or Stop detail context) → `NewOrderScreen`: pick/lock customer → scan/add products → Cart review → **Save order** (`POST /orders`, with run/stop link when stop-scoped; Merge/Separate if an open order exists).
- **Offline stop-completion replay:** Driver completes a stop while offline → action enqueued in `offlineQueue` (persisted to AsyncStorage, Idempotency-Key preserved) → banner shows "N queued" → on reconnect `useNetworkSync.drainQueue` replays; before a stop-complete it re-checks the run (`GET /route-runs/:id`) and **drops** the action if the run was CANCELLED (RF-170); 4xx discards immediately, 5xx retries up to 3 times.

### Use cases

- As a driver, I want to start my day optimized from where I'm parked so that my stop order reflects my real starting point. (path: Route/StartOfDay → Start day)
- As a driver, I want the next stop and a live progress bar front-and-center so that I always know where to go and how much is left. (path: Route/TodaysRoute)
- As a driver, I want turn-by-turn Maps with only my remaining stops so that I don't reroute past completed ones. (path: Route → Maps / Payment "Open Maps")
- As a driver, I want to capture a photo and signature before collecting payment so that I have proof of delivery on every stop. (path: Stop detail → Photo/Signature → Payment)
- As a driver, I want a big keypad with quick-tender and automatic change so that I can take cash fast and close the stop in one tap. (path: Payment)
- As a driver, I want a stop-completion to survive a dead zone without double-charging so that I don't lose or duplicate a delivery. (path: Payment offline → offline queue replay)
- As a driver, I want to log damaged/refused goods and issue a credit so that the customer isn't billed for what they didn't get. (path: Stop detail → Return & credit)
- As a driver, I want to split a big order into separate invoices with different due dates so that a customer can pay in parts. (path: Stop detail → Split invoice)
- As a driver, I want to add an order for a walk-in or an add-on at a stop so that I can sell beyond the manifest. (path: New order / Stop new-order)
- As an operator covering a route, I want to switch into the driver view so that I can run deliveries myself. (path: More → Switch role)

### Business rules & edge cases

- **Run state machine:** exactly one of NoRoute / StartOfDay (a SCHEDULED run) / TodaysRoute (an IN_PROGRESS run) / all-done renders, driven by `useActiveRouteRun` (status IN_PROGRESS, assignedToMe) and `useScheduledRouteRuns` (SCHEDULED). Completing the run requires an explicit confirm and "locks all stops".
- **Location tracking mirrors run lifecycle:** starts on active run appearing / Start day, stops when the run disappears. Native tracker posts to `POST /drivers/me/location` (foreground+background, Balanced, 30 s / 50 m, foreground-service notification). Foreground-only fallback when background permission is denied; web has no tracking.
- **POD is a local scratchpad:** photos/signature/note live only in `usePodStore` keyed by stopId until completion, when they're sent in the complete-with-payment body and then cleared. POD is **not required** by the UI to complete a stop (the tiles are optional; the payment amount is the only gate).
- **Payment gating (RF-006 / NEW-m1-3):** Cash/Card/Cheque require a non-zero received amount; "On account" collects $0. At least one delivery item must exist. `collected = min(received, invoiceTotal)` — never overpay the invoice. Payment only attaches when the order has an `invoiceId`.
- **Atomicity + idempotency (RF-005 / BUG-DRV1-3 / RF-019):** completion and payment go through a single `complete-with-payment` endpoint carrying a per-attempt Idempotency-Key so an offline retry can't double-charge (server returns the original response).
- **Integer quantities:** all `quantityDelivered` and return `qty` are `Math.round`ed to integers before submit. In `NewOrderScreen`, boxed products (unitsPerBox > 1) are edited as integer **boxes + loose pieces** (loose capped at unitsPerBox−1) and the server recomputes `qty = boxes*unitsPerBox + pieces`.
- **Price-override convention:** the cart's editable price is a one-time override; it is only sent when strictly below the catalog price, and shown against "Current"/"Last" price hints. Line subtotals use the shared `pricing.ts` helpers (`computeLineSubtotal`/`effectiveQty`/`roundMoney`) so the box price prorates loose pieces — the display never re-derives `qty*unitPrice` for boxed lines.
- **Merge guard:** creating an order for a customer with an existing open order forces an explicit **Merge / Create separate** choice (client pre-check via `GET /orders/active`, plus server 409 `MERGE_CHOICE_REQUIRED` fallback).
- **Returns mapping:** UI reason labels collapse into 5 API enums; PARTIAL and REFUSED delivery mutations become return items; the resulting credit "applies to next invoice".
- **Split-invoice constraints:** per-item allocation across drafts can't exceed `qty − invoicedQty`; drafts are POSTed **sequentially** to avoid racing `invoicedQty`; a partial-failure mid-batch keeps already-created invoices ("Created" badge) and is resumable; the composer pre-fills the first draft with all remaining items.
- **Offline replay (RF-170 / CRIT-05):** queue persists to AsyncStorage; on reconnect, stop-completions re-verify the run and are silently dropped if it was CANCELLED; non-retriable 4xx are discarded, 5xx retried up to 3 times, then dropped.
- **Multi-tenant:** everything runs under the JWT's `tenantId`; the More/Profile screens surface the tenant's `branding.businessName`. Role switch (operator↔driver) is a client-side `setActiveRole` + replace, gated by the account's roles.
- **Not-yet-built (honest empty states, no endpoints):** **Cash up** and **Messages** are placeholders; the hi-fi demo data was intentionally removed.
- **Deep-link resilience:** stop/payment/return/split screens derive `runId` from the URL param or fall back to the active run; back buttons `router.replace('/(driver)/route')` rather than relying on a (possibly empty) history stack.
- **Skip stop is currently cosmetic:** the "Skip stop" confirm on the stop screen navigates back without writing a SKIPPED status (a `useUpdateStopStatus`/`PATCH /route-runs/:runId/stops/:stopId` hook exists in the API layer but is not wired to this button).

Key files: `apps/mobile/app/(driver)/**`, shared `apps/mobile/components/{NewOrderScreen,SplitInvoiceScreen,MessagesScreen,PhotoCapture,SignaturePad}.tsx`, state `apps/mobile/store/{podStore,offlineQueue}.ts`, sync `apps/mobile/hooks/useNetworkSync.ts`, tracking `apps/mobile/lib/location-tracker.native.ts`, API `apps/mobile/lib/api/{routes,returns,orders,invoices}.ts`.
