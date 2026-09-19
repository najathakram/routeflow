# mobile — Screens by role

> Split from `.claude/code-map/mobile.md` (verbatim, lines 205-378) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Screens by role (`app/`)

### `(auth)/`

- `login.tsx` (username/password + Google + tenant slug), `sign-in.tsx` (entry decision),
  `role-picker.tsx` (operator vs driver — Driver card hidden + auto-select operator without
  developer mode), `company-code.tsx` (tenant lookup),
  `customer-login.tsx` (buyer), `google-callback.tsx`, `force-change-password.tsx`,
  `forgot-password.tsx`, `reset-password.tsx`, `operator-blocked.tsx`.

### `(customer)/` — buyer app

- root `_layout.tsx` — Stack, `useBuyerSocket()`, buyer/activeSeller gate.
- tabs `(tabs)/_layout.tsx` — Home, Orders, Catalog, Invoices, More.
- `(tabs)/home.tsx` (dashboard, recentOrders w/ itemCount fallback, balance), `orders.tsx`,
  `catalog.tsx` (tier pricing; **#225:** `useBuyerProductsInfinite` pages the whole catalog + pull-to-refresh, NavBar heart→`favorites.tsx`/shield→`licenses.tsx` icons replacing the old Alert popup, floating cart total is promo-aware via `priceCart`; **P5-16a:** inline `ProductCard` tile gained image, struck promo price + live-stock label + merch/behavioral chips via `lib/catalog-tile-logic.ts`, OOS Notify-me/Notifying toggle via `useSubscribeStockAlert`/`useUnsubscribeStockAlert` — see "Buyer catalogue v2 + stock alerts" row above), `invoices.tsx`, `more.tsx` (**#225:** Finances/Favorites/Licenses rows added; Unpaid stat now reads `dashboard.stats.unpaidInvoiceCount`, was a phantom field always 0).
- `profile.tsx`, `orders/[id].tsx` (detail, cancel, **WP2:** per-line `item.notes` under the qty/price line when present), `orders/[id]/edit-items.tsx` (DRAFT qty),
  `orders/cart.tsx` (checkout → `POST /buyer/orders`; **#225:** promo-priced via `priceCart`/`promoRulesFrom`, strikethrough + "Promotion savings"), `invoices/[id].tsx` (record-payment, **Share PDF** when `pdfUrl` present, **WP2:** per-line `item.notes` in `LineItemRow`; **B421 (2026-09-15):** `paidAmount`/`balanceDue` were already server-driven with no local re-derivation, so the server's B421 fix alone corrects them — added `creditApplied`/`advanceApplied` to `BuyerInvoice` + conditional "Credit issued"/"Advance applied" `DetailRow`s in the Summary card, own-computed `lastSummaryRow` so only the actually-last row drops its bottom border regardless of which rows show),
  `change-password.tsx`, `standing-orders.tsx` (recurring calendar).
- **#225 new:** `favorites.tsx` (hearted products, add-to-cart/un-favorite), `finances.tsx` (spend/invoice-status summary, `useBuyerAnalytics`, no chart lib), `licenses.tsx` (submit/renew regulated-category licenses) — see "Where to find" rows above.
- **P5-16c new:** `payments.tsx` (wallet + payment history + statement PDF download) — see "Buyer payments/credits/statement" row above.
- **F30 new (2026-08-31):** `scan.tsx` (buyer scan-to-cart; `BarcodeScanner continuous`, resolves via `lib/api/buyer.ts` `resolveBuyerProductByCode` → `GET /buyer/products/scan/:code`, adds through the same `cartStore.add` the catalog tile's + button uses, so a re-scan increments the line) — entered from the `barcode-outline` NavBar button on `(tabs)/catalog.tsx`, the FIRST customer-side scan affordance. ⚠️ A pushed SIBLING Stack screen, not an in-tab overlay: the tab bar renders outside the tab screen, so an absolute-fill overlay inside `(tabs)` leaves the camera under it. ⚠️ Every branch stays in scan mode and a network/5xx/timeout is reported as "couldn't look up", never as "not found". See the F30 batch section below.

### `(driver)/` — tabs: Route, Map, Orders, Menu

- **At-door money is server-derived, never `qty × unitPrice` (F05, B49/B152).** `lib/run-money.ts`
  (pure, jest'd `__tests__/run-money.test.ts`) is the single source for every driver money figure:
  `lineItemSubtotal` prefers the server's `subtotal` (a Prisma Decimal — arrives as a STRING, so
  it goes through `Number()`) and falls back to `computeLineSubtotal` from `@routeflow/pricing` for a
  payload cached before F05; `sumOrderLineItems`/`sumStopOrders` reduce over it. It replaced four
  independent `qty * unitPrice` reducers — route total value (`route/index.tsx`), per-stop amount
  due (`stop/[stopId]/index.tsx`), at-door `fullOrderTotal` (`payment.tsx`) and the return screen's
  original total — each of which over-charged a boxed line by ~`unitsPerBox` (48 pieces at a $30
  BOX price billed $1,440 instead of $60) **and posted that inflated figure as `payment.amount`**.
  `payment.tsx`'s two-tier `invoiceTotal` (first order keeps the short-pick `reconciledTotal`) and
  its `Math.min(received, invoiceTotal)` change-giving cap are unchanged — only the basis was wrong.
- **F38 — the at-door amount due is the server's open-draft invoice; the short-pick estimate
  matches the SAME line set (B305, 2026-09-13, PR #710).** `run-money.ts` gains `RunMoneyInvoice`
  (one open DRAFT — `subtotal`/`taxAmount`/`discount`/`shippingFee`/`total`) and
  `orderAmountDue(order)` = Σ `order.invoices`' `total` (ALL open drafts — a regulated split order
  carries base + `-R#` siblings, never just the first) when at least one is finite, else the legacy
  `sumOrderLineItems` pre-tax fallback (never a client-side `Order.total - discountAmount` guess —
  unsafe once an order is edited/merged past create). `stopAmountDue(stop)` sums it per stop;
  `payment.tsx`'s `fullOrderTotal` and `stop/[stopId]/index.tsx`'s `dollarTotal` now call these
  instead of `sumOrderLineItems`/`sumStopOrders`. `deliveredCategoryTax(lineItems,
deliveredQtyById)` = Σ each line's `categoryTaxAmount` (new on `RUN_LINE_ITEMS_SELECT`, mirrored
  onto `lib/api/routes.ts#RouteRunOrderItem`) scaled by delivered/ordered qty share (a line absent
  from the map defaults to fully delivered — matches `short-pick.ts#buildDeliveries`);
  `reconciledAmountDue({drafts, order, deliveredSubtotal, deliveredCategoryTax, isTaxExempt})`
  reproduces the server's delivered-basis rule exactly
  (`invoices.service.ts#reconcileOrderDraftInvoice`): `deliveredSubtotal − Σdraft.discount +
Σdraft.shippingFee + order.tax×(deliveredSubtotal/order.subtotal) + deliveredCategoryTax`, both
  tax terms zeroed when `isTaxExempt` (mirrors `RUN_STOP_INCLUDE.customer.isTaxExempt`, projected
  onto `lib/api/routes.ts#RouteRunStop.customer`). **Round 4 seam fix (`df635fdb`):** `payment.tsx`
  fed `deliveredSubtotal` from the filtered `shortPickLines` but `deliveredCategoryTax` from the
  RAW `o.lineItems` — since `deliveredCategoryTax` defaults an unlisted line to fully delivered, a
  CANCELLED or already-delivered regulated line leaked its full category tax into the quote while
  contributing zero subtotal (cash over-collected at the door). New `shortPickCategoryTax(lineItems,
shortPickLines, deliveredQtyById)` restricts the sum to `shortPickLines`' ids and delegates to
  `deliveredCategoryTax`; `payment.tsx` calls it so both halves derive from ONE line set, and the
  invoice label appends " (est. — final on invoice)" whenever a short-pick estimate is shown.
  Fenced by a SOURCE PIN (`__tests__/short-pick-category-tax.pins.test.ts` — the unit tests can't
  import the RN screen, so a revert to the raw-lines call would otherwise stay green). Specs:
  `__tests__/run-money.test.ts` REG-B305 (rounds 2-4).
- **Run settlement is server-gated (F05, B152/B167).** `shouldForceSettlement(run, storeSignal)` in
  `lib/run-settlement.ts` decides the complete-route branch from the run payload
  (`collectedPayments` + `settlementNote`), OR'd with the device store only to cover the moments
  after a collection before the query refetches. `store/runSettlementStore.ts` is still RAM-only by
  design but is **no longer the gate** — it was, which meant any app restart made the reconciliation
  step silently vanish. `settlement.tsx` shows the server's expected figure, submits through
  `useSettleRun` (`POST /route-runs/:id/settlement`) and then flips COMPLETED; the old
  notes-append PATCH is gone. Two non-atomic writes, so a retry re-runs only the status flip
  (`settledRef` + the server's `RUN_ALREADY_SETTLED` code). If the server's recomputed expected
  disagrees (a payment landed since the screen loaded) its 400 latches the reason field open and
  refetches — the field is gated on the CLIENT variance and would otherwise never render.
- root `_layout.tsx` — Tabs, `useSocket()`, OfflineBanner.
- `route/index.tsx` (active run, stop list, optimize, complete-route),
  `route/stop/[stopId]/` → `index.tsx` (detail + delivery mutations), `photo.tsx` (POD →
  `podPhotoUrls[]`), `signature.tsx`, `payment.tsx` (cash; `closeStop()`'s regulated age/ID/
  signature pre-check now calls `lib/pod-gating.ts` `regulatedPodGateError()` instead of an
  inline `if` ladder — P10-REG-B, behavior-preserving), `note.tsx`, `return/index.tsx`,
  `new-order.tsx`, `split-invoice.tsx` (partial delivery).
- **`route/stop/[stopId]/return/index.tsx` — F08 (2026-09-06, #645):** rewired onto the ONE
  `undeliveredReturnLines(toUndeliveredStop(stop, lineExtras))` call in `lib/returns-logic.ts` for
  rows, the displayed total AND the POST payloads (previously drifted independently) — a per-row
  Damaged toggle feeds `opts.damagedKeys`; `extrasReady`/`extrasFailed` gate submission on the
  order-detail fetch (`orderQueryOptions`, below) that supplies `lineExtras`, with an inline
  "Retry" control on failure rather than submitting with a wrong (zeroed promo) amount; Submit
  POSTs one create-return per order via `Promise.allSettled`, folded by `summarizeSubmissions`
  into landed-vs-retry with a toast when every row nets to zero. The rewire itself is not
  jest-provable (RN screen); the helper is the tested oracle (stated in #645's PR body).
- **F38 — an offline-queued mutation reads as success, not a failure (B307/B308, 2026-09-13, PR
  #710).** NEW `lib/offline-errors.ts#classifyMutationError(e)` → `{kind: "queued"|"error",
message}` (mirrors the pattern already correct in `skip-stop.ts:48-57`) — `api-client.ts:183`
  rejects with `{isOfflineQueued: true}` once a mutation is enqueued, which is a PENDING success,
  not a rejection. Three call sites: `payment.tsx`'s completion `catch` runs the success-path
  cleanup (clear POD/plan, record the collection, offer the Google-Maps continue prompt) instead
  of re-arming the Complete button, toast "Offline — completion queued…" (known gap, filed: the
  payment-photo upload is dropped on this path — it needs `paymentIds` off a real, non-queued
  response); `components/NewOrderScreen.tsx`'s submit `onError` classifies FIRST and, when queued,
  awaits `finalizeBoundDraft()` and navigates back WITHOUT `endSubmit()`/`resetOrderSubmitKey()` —
  releasing the latch or rotating the key before the queued POST resolves would let a double-tap
  mint a second create whose fresh key the original queued request can't dedupe against;
  `return/index.tsx` carries the flag through `ReturnSubmissionResult.isOfflineQueued` into
  `summarizeSubmissions` above, which now returns a third bucket **`queued: string[]`** (always
  present, empty when nothing queued) — an offline-queued return is filed there, never in
  `failed`; the return screen marks queued ids submitted alongside `done` and toasts "Offline —
  return queued…" instead of "Return submitted". Specs: `__tests__/offline-errors.test.ts`,
  `__tests__/returns-logic.test.ts` REG-B307/REG-B308.
  **2026-09-14:** `offline-errors.ts` gains a second, deliberately separate predicate
  `isStopAlreadyCompletedError(e)` (400 + "already completed" substring) — `payment.tsx`'s retry
  path treats it as success rather than re-arming the Complete button, since the server refuses
  any write once the stop is COMPLETED. Detail: `mobile/tests-2.md`'s "2026-09-14 —
  hunt-mobile-scan lanes A-E" §Lane D.
- **Durable POD (2026-08-28):** `lib/pod-artifacts.ts` (pure, spec'd in
  `__tests__/pod-artifacts.test.ts`) — `strokesToSvgDataUrl` (stroke vectors → SVG data URL,
  white bg, null for tap-only; used by `components/SignaturePad.tsx` on BOTH platforms — the
  canvas/`"native-captured"` sentinel paths are GONE, server rasterizes at ingest) +
  `podPhotoArtifactId` (stable djb2 id for idempotent attach replays) + `asciiToBase64` (no
  Buffer/btoa on RN). `components/PhotoCapture.tsx` gained `output="data-url"` (resize ≤1280px
  - JPEG q0.6 base64 via expo-image-manipulator; payment-photo/product callers keep the default
    `"uri"`); `photo.tsx` uses it. `payment.tsx` `closeStop()` uploads each data-URL photo via
    `useAttachPodArtifact` (`lib/api/routes.ts` → `POST .../pod-artifact`, JSON so it offline-queues
    FIFO ahead of the queued completion; failures swallowed — never blocks the driver), sends the
    signature SVG inline in the completion (regulated gate needs it on THAT request), and NO LONGER
    sends `podPhotoUrls` (would overwrite server-appended keys); `closing` state guards the whole
    multi-request sequence against double-tap.
- `map.tsx` (route map, live position, openInMaps), `orders.tsx`, `driver-profile.tsx`,
  `driver-menu.tsx`, `driver-messages.tsx`, `driver-change-password.tsx`, `driver-new-order.tsx`, `cash.tsx`.

### `(operator)/` — tabs: Home, Dispatch, Orders, Warehouse, Finance, More

- root `_layout.tsx` — Stack, `useSocket()`, OfflineBanner, **and the single addon deep-link chokepoint** (`sectionNeed`) for `dispatch|routes|route-runs|trips|drivers|driver|fleet` (see "2026-08-25 — recurring-routes / order-delivery addon split"). tabs `(tabs)/_layout.tsx` (popTabToRoot on re-press).
- `(tabs)/home.tsx` (KPIs), `dispatch.tsx` (routes calendar, driver assign), `warehouse.tsx` (+ inventory-value KPI w/ missing-cost count via `useInventoryValuation`, tappable → Set-missing-costs only — **B562 (#931, 2026-09-19): the "Recompute costs" menu item is REMOVED** (interim mitigation; target screen `products/recompute-costs.tsx` left in place, unreachable — see `api/feature-modules-4/inventory.md`'s B562 entry); **#225:** "Count" quick-action → `products/stock-count.tsx`), `finance.tsx`, `more.tsx`.
- **Cost basis (mirrors web):** `products/[id]/set-cost.tsx` (audited COST_BASIS via PATCH /inventory/products/:id/cost-basis); product detail shows effective cost (standardCost ?? averageCost) w/ "No cost set" chip; vendor-bill receive sends `{id, acknowledgeUnlinked?}` + native confirm on UNLINKED_ITEMS 409 (`getUnlinkedItemsError`/`billNeedsMapping` in `lib/api/vendor-bills.ts`); `movements.tsx` renders COST_BASIS rows (shows set cost, not qty).
- **Tobacco (addon-gated, mirrors web):** `tobacco/index.tsx` — KPIs, report list (PDF share via `sharePdf`), generate last month, flagged inventory; conditional More-menu row + product detail mark/unmark action, all gated on `useHasAddon("tobacco_dealer")` (`lib/api/tobacco.ts`).
- **Regulated Items hub (P10-REG-B):** `compliance/` (Stack layout) → `index.tsx` (KPIs + per-section list + filings roll-up), `[id].tsx` (per-section KPIs, monthly YTD ledger list, subcategory chips, Prepare filing) — unconditional More-menu row under INSIGHTS (`compliance` route, not the unbuilt `regulated/` REG-2 manager). See "Regulated Items hub" Where-to-find row above.
- **B4 + B6 invoice detail (2026-08-20):** `lib/invoices-logic.ts` gained **`canRecordPayment(status)`** mirroring web's allow-list exactly (`SENT | VIEWED | PARTIAL | OVERDUE`). Mobile previously computed `canRecord = !isPaid && !isVoid`, which let DRAFT through — the server's `recordPayment` only rejects VOID, and `recomputeStatus` treats DRAFT as terminal, so a fully-paid invoice **stayed DRAFT and silently dropped out of AR/aging**. Also (B6) the **Send** and **Send reminder** `ActionTile`s only swapped their label on `isPending` while staying tappable, so a double-tap sent twice / emailed twice — they now pass `disabled` (the Share tile already did this correctly) and their handlers early-return when the mutation is in flight.
- **In-app pack size (2026-08-20) — capture `unitsPerBox` where the operator already is.** Context: only 19 of 1,743 live products carried a pack size, and EVERY boxed affordance gates on `unitsPerBox > 1` (box-price proration, boxes/pieces inputs, box-aware scan, stock-count denominations, variant split), so all of that machinery was dormant. Two capture points, both driven by the single shared parser in `@routeflow/types` (`suggestPackSize`) — never a local re-implementation:
  - **Product create/edit** — an inline dismissible prompt when a pack size is suggested and `unitsPerBox` is unset. `HIGH`/`MEDIUM` pre-fills the parsed count; **`AMBIGUOUS` states the conflict and pre-fills NOTHING**; `LOW` asks quietly; **`PIECE_UNIT` renders nothing at all**. Writes through the existing product mutation — no new endpoint.
  - **Order builder line** — a quiet "Sold in a box?" affordance that PATCHes the product and re-renders the line as boxed via the existing cases/pieces inputs.
  - ⚠️ **Setting `unitsPerBox` RE-PRICES the line** — it switches from `qty × unitPrice` to BOX-price proration, so the affordance surfaces the resulting line total rather than silently changing money on screen.

- **PR-B (2026-08-20):** `lib/api/product-sales.ts` (`useProductSales`) + `lib/product-sales-logic.ts` (pure `productSalesSummaryLine` — collapses a single-price range and drops the price clause when there is none — and `productSaleRowTarget`, which routes a row to the ORDER when `orderId` is set and the INVOICE otherwise, covering invoices cut without an order). `(operator)/products/[id].tsx` gained a **Sales card** (card rows, not a table — this is a phone): summary strip + the **8 most recent** lines only (`SALES_ROWS_INLINE`; the API returns up to 200 and the summary still covers ALL of them), then "View all N sales" → the product-filtered orders list. Money renders exactly as the server sent it; only boxes/pieces go through `formatQtySplit`. The orders index now carries TWO independent dismissible chips (customer AND product) — both pairs of pure rules live in `lib/customer-order-filter.ts`, each dismissal clearing only its own state + route param.
- `(tabs)/orders/` → index (status filter; **#225:** DRAFT filter chip; **A3 2026-08-19: reads the `customerId` route param the customer screen pushes — it used to be DROPPED, so "View orders" showed every order — forwards it to `useAdminOrders` and renders a dismissible "Customer: X" chip whose label comes from `useAdminCustomer` (correct even at zero orders); dismissing clears the state AND `router.setParams`. Pure rules in `lib/customer-order-filter.ts` + specs**), `[id].tsx` (assign driver, split-invoice; **"Edit items" entry shown for DRAFT/PENDING/CONFIRMED** — mirrors API guard; **#225:** `useReopenOrder` CANCELLED→PENDING action, `SendInvoiceSheet` re-send on DELIVERED orders via `useCreateInvoiceFromOrder`), `[id]/edit-items.tsx` (integer-qty stepper; `PriceOverrideModal` new-price **+ "Amount off / unit"** lens, **price edit on DRAFT/PENDING/CONFIRMED** (gated by `canEditPrice`; was DRAFT-only) — read-only on terminal statuses; fresh adds pre-fill remembered price via `useCustomerPriceHistory`; **#225:** save now builds a minimal `buildOrderItemDiff` sent with `replaceAll:false`, was a full id-less resend that wiped invoiced/override history on untouched lines); **#668 (B246 option C):** the line-list
  branch now mounts `BarcodeFab` (`hidden={scanFabHidden(...)}` via new `lib/scan-fab-visibility.ts`,
  gated on pricing-ready/picker-open/price-modal-open/other-blocking-modal-open; `onPress` opens the
  local `ProductPicker` pre-armed to scan via a new `initialScanOpen` prop — 1 tap after Apply, was
  2, no second scanner/pricing path), `[id]/split-invoice.tsx`. **2026-09-14 (hunt-mobile-scan lane
  A):** lazy-gated product search, a `scan-accept-guard.ts` dedup claim, and a staged-edit
  AsyncStorage snapshot (`lib/edit-items-draft.ts`, restore-on-reopen) replace the old always-fetch
  picker and unprotected in-progress edit — `canEditPriceFor` now also requires `pricingReady`
  (B62). Full detail: `mobile/tests-2.md`'s "2026-09-14 — hunt-mobile-scan lanes A-E" section.
  **PR #748 review fix round:** the staged-edit write ref now refuses to persist while
  `useAuthStore`'s `user?.id` is undefined (cold open/deep link) — no snapshot is ever written
  under the shared `anon` key bucket, closing a B136/B137-class cross-operator leak on a shared
  device; `session-teardown.ts` also sweeps the anon prefix belt-and-braces.
  **B465 (2026-09-16/17, mirrors web):** `PriceOverrideModal`'s save is disabled
  (`reasonMissing = isSpecial && reason.trim() === ""`) with a required-field red ring when the
  line resolves SPECIAL tier — server-side guard is `orders.service.ts`'s reason-required check
  (see `api.md` orders/ B465 bullet). `lib/order-item-diff.ts`'s `buildOrderItemDiff` now sends
  `overrideReason` whenever EITHER the price OR the reason changed (was: reason-changed only) —
  a price-only change on an already-reasoned line must still carry that reason on the SAME
  request, or the server's reason-required refusal has no stored reason to fall back on.
- **Share retap made synchronous (2026-08-27, Samsung Internet dead-end):** `lib/share-pdf.ts`
  `canShareFilesHere()` now probes FILE support via a sync `canShare({files:[probe]})` (Samsung
  Internet exposes share()/canShare() but rejects files — it was taking the file-share path and
  ending in a silently popup-blocked window.open); `sharePdfWeb` gained a **synchronous retap
  fast path** off `pendingCache.peek()` (new — resolved-value peek, identity-safe, contract in
  `__tests__/pending-cache.test.ts`): a second tap with the file cached reaches share() or a
  gesture-synchronous window.open with ZERO awaits; every `window.open` fallback goes through
  `openTabOrOffer()` which detects popup-block (null return) and raises an explicit "Open PDF"
  button — no share path can end silently anymore. Cold path skips the PDF download entirely on
  file-share-less browsers. WhatsApp channel auto-falls-back to the wa.me text link there
  (`planWhatsAppSend` unchanged — it already keyed off `canShareFilesHere()`).
- `(tabs)/invoices/` → index (status), `[id].tsx` (payments, **Share PDF → `sharePdf()` direct share**; **#225:** write-off tile → `[id]/write-off.tsx`, pencil on editable payment rows → `[id]/payments/[paymentId]/edit.tsx`; **B421 (2026-09-15):** `AdminInvoice` gains `creditApplied`/`advanceApplied`, surfaced as two conditional own-line `Text`s under the existing "of {total} · paid {paidAmount}" summary sub-line — "Credits applied"/"Advance applied", neutral (not the balance's own color); `paidAmount`/`balanceDue` themselves needed no code change, already server-driven), `[id]/record-payment.tsx` (**#225:** dropped the Advance/Credit-Note method chips — server always rejected them here), `create.tsx`, `new.tsx`.
- `customers/` → index (**2026-07-30, WP15:** `FilterChipRow` All/Regulated passing `regulated` through `useAdminCustomers` — cast to bypass `lib/api/admin.ts`'s untyped param, out of this WP's file scope), `[id].tsx`, `[id]/edit.tsx`, `[id]/addresses.tsx`, `[id]/catalog.tsx` (per-customer tier pricing; module-level `tierUnset()` appends a subdued "(list)" suffix on the override-row price + modal tier-hint when the tier column is 0/unset — `getTierPrice` already falls back to list), **`[id]/documents.tsx`** (2026-07-30, WP15 new: view/share/delete customer document library — `lib/api/customers.ts` `useCustomerDocuments`/`useDeleteCustomerDocument`; tap-to-view uses `expo-web-browser` `openBrowserAsync` on native, a modal `<iframe>` via `React.createElement("iframe",...)` on web (mirrors `components/MapView.tsx`'s web-map pattern, no react-native-webview dep); share via `sharePdf`; upload out of scope. Not yet linked from `[id].tsx` — that file is outside WP15's scope, so the screen has no in-app entry point beyond direct navigation), `new.tsx`/`create.tsx`.
- `drivers/` → index, `[id].tsx`, `[id]/edit.tsx`, `new.tsx`/`add.tsx`. `[id]/edit.tsx` carries a
  **"Home base"** section (line1/city/state/zip → `UpdateDriverDto.home*`, mirroring web's
  `EditDriverModal`) — the only mobile writer of the fields `trips.service.ts resolveOrigin`'s
  DRIVER tier reads. It prefills by splitting the stored composed `Driver.homeAddress` and omits
  the home fields entirely when none is set and none typed, so a phone/vehicle-only save never
  triggers the API's recompose + re-geocode.
- `products/` → index (barcode lookup; **#225:** `useAdminProductsInfinite` FlatList paging, id-de-duped, replaces the `limit:100` fetch), `[id].tsx` (**#225:** "Photos" card — camera/library capture via `useUploadProductImages`/`useDeleteProductImage`, HEIC→JPEG transcode), `[id]/adjust-stock.tsx`, `new.tsx`/`create.tsx`, `adjust-picker.tsx`, **#225 new:** `bulk-set-cost.tsx`, `recompute-costs.tsx`, `stock-count.tsx` (scan-driven physical count → `POST /inventory/stock-count/commit`).
- `returns/` (**#225:** `index.tsx` rows tap through to `[id].tsx` new detail screen — status-gated action tiles over the full 8-status ladder; `new.tsx` new 3-step create-return: customer→DELIVERED order→per-line qty+restock), `routes/`, `purchase-orders/` (Stack layouts); `new-order.tsx`, `pick.tsx` (pick-list),
  `exceptions.tsx`, `analytics/index.tsx`, `movements.tsx`, `messages.tsx`, `fleet.tsx`, `driver.tsx`,
  `profile.tsx`, `change-password.tsx`, `expenses/{index,[id],new}.tsx`.
- **Analytics perf hooks widened (2026-08-28, mirror of web):** `lib/api/admin.ts` `useAnalyticsRoutePerformance`/`useAnalyticsDriverPerformance` now accept `(from?, to?)` (params + queryKey) and both row types extend `RunOpsMetrics` (`onTimeRate`/`stopsPerHour`/`avgRunDurationMinutes`, nullable = no measurable data). No mobile screen renders these two hooks yet — `analytics/index.tsx` uses DSO/AOV/top-products/top-customers only.
- `recurring-invoices/` → `index.tsx` (**#225:** "New" NavAction), `[id].tsx`, **#225 new:** `new.tsx` (customer→schedule[frequency chips + `recurringScheduleFields`]→item builder via `useCreateRecurringInvoice`). **2026-09-14:** its `ProductPickerModal` now gates the catalogue fetch on a term or a "Browse catalogue" tap (`browsing` state, resets on close) instead of loading on mount — same lazy-load pattern as `ProductPickerSheet.tsx`; see `mobile/tests-2.md`'s "2026-09-14" §Lane E.

### `(tenant)/` — tenant-admin dashboard

- root `_layout.tsx` — Tabs (Today, Dispatch, Billing, Settings, More; the Dispatch `Tabs.Screen` carries `href: devMode ? undefined : null`). Operator-like scope with org-level controls.
