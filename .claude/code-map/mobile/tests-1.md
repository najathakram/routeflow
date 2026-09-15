# mobile — Tests (part 1 of 2)

> Split from `.claude/code-map/mobile.md` (verbatim, lines 379-932) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Tests (`__tests__/`)

- `socket-wiring.test.ts` — role-namespaced token reads, Socket.IO init, transport order [polling, websocket].
- `buyer-home-dashboard.test.ts` — guards undefined `lineItems`, falls back to `itemCount`.
- `operator-create-forms.test.ts` — form validation (new customer/driver/product/order).
- `qty.test.ts` — `sanitizeIntInput`/`parseIntQty` (integer qty: no decimals/leading zeros).
- `pricing.test.ts` — imports `@routeflow/pricing` (`computeLineSubtotal`/`roundMoney`/`normalizeBoxesPieces`); golden cases now live in `packages/pricing/src/pricing.spec.ts`.
- **#225 mobile-parity waves:** `scan-loop.test.ts` (`gateScan` cooldown), `visible-cart.test.ts` (`withCartRows`), `order-item-diff.test.ts` (`buildOrderItemDiff` — 15 cases incl. zeroed-line auto-DELETE), `buyer-cart-pricing.test.ts` (`priceCart` promo lines/savings), `authorizations-logic.test.ts` (`parseRegulatedAuthError`/`overrideScope`), `invoice-actions.test.ts` (`canWriteOff`/`isPaymentEditable`), `invoice-send-helpers.test.ts` (wa.me/sms deep-link formats), `order-draft-gate.test.ts` (`orderSubmitGate`), `returns-logic.test.ts` (`returnPillFor`/`returnActionFlags`/`buildReturnItems`), `stock-count-logic.test.ts` (`addScanToRows`/`rowVariance`/`buildCommitItems`), `product-image.test.ts` (`productImageFile`/`mimeFromUri`), `buyer-finances-logic.test.ts` (breakdown %/bar math), `buyer-licenses-logic.test.ts` (status pill/CTA), `recurring-invoices-helpers.test.ts` (extended: `recurringScheduleFields`).
- **P5-16b:** `shelf-logic.test.ts` (`groupShelfEstimates`, MONEY-guarded `buildShelfAddItem` box split + cent-parity, `qtyLabel`/`daysLeftFraction`/`daysLeftLabel`, `orderEditable`/`orderCancellable`/`canRequestChange` gates, `changeRequestChip`/`describeChangeRequest`/`describeResolution`).
- **P5-16a:** `catalog-tile-logic.test.ts` (`tileCta`/`alertIdSet`/`deriveTilePrice` cent-parity w/ `priceCart`/`computeTileChip`/`behaviorLabel`/`stockLabel`).
- **P5-16c:** `check-badge.test.ts` (check-payment status badge classification), `buyer-payments-logic.test.ts` (row/format helpers — display-only, no derived money).
- **P10-REG-B:** `pod-gating.test.ts` (`regulatedPodGateError` — signature/age/identity/identity-type ladder, incl. the age-before-identity ordering case); `regulated-format.test.ts` extended with `lastCompletedPeriod` (MONTHLY/QUARTERLY/ANNUAL rollover via fake timers) and `fmtMoney` (number/Decimal-string/undefined/NaN inputs).
- **P10-REG-C:** `invoice-split.test.ts` (`groupLinesForInvoiceSplit` — 12 cases: Standard-fold for uncategorised/SEPARATE_SECTION/LINE_TAX lines, SEPARATE_INVOICE grouping + name-sort, single-group→no-split, cent-parity for boxed lines); `invoice-siblings.test.ts` (`siblingInvoicesOf` — 5 cases: no group, undefined current, self-exclusion, group/id mismatch filtering, order+field passthrough).
- **D1 (2026-08-19):** `substitute-line.test.ts` (`buildSubstituteLine` — 9 cases: re-denomination against the SUBSTITUTE's box size, loose remainder, box-UNAWARE selling-unit expansion, loose→case split, no split on a loose substitute, tier price on the wire, no `unitPrice` at list, typed override + reason, this-session row stays a new line); `order-item-diff.test.ts` extended with the B1/B2/B3 payload cases.
- **F30 (2026-08-31):** `scan-camera-buffer.test.ts` (pending buffer: depth-2 cap, dedupe by normalized code, drain order), `sale-line-fold.test.ts` (boxed increment/decrement/piece folds a typed plain qty — REG-B194), `barcode-resolve-archived.test.ts` (the `archived` outcome + sellable-only ambiguity list), `wedge-submit.test.ts` (synchronous field clear on a scan code but NOT on a typed name, mid-resolve burst buffered not concatenated), `offline-queue-failed.test.ts` (4xx / retry-exhausted → persisted `failedActions`, never a bare dequeue), `api-client-timeout.test.ts` (online timeout is NOT enqueued), `toast-ios.test.ts` (iOS `showToast` → registered host, Alert fallback); `scan-loop.test.ts` + `order-draft-gate.test.ts` extended.
- **#668 (2026-09-08, B246 option C):** `edit-items-scan-fab.test.ts` (REG-B246, source-text:
  exactly one `<BarcodeFab` mount in the line-list branch, its `hidden={scanFabHidden(...)}` cites
  all four visibility flags, `ProductPicker` declares `initialScanOpen` and seeds `scanOpen` from
  it, the FAB's `onPress` sets picker-open + scan-intent), `scan-fab-visibility.test.ts` (REG-B246,
  pure logic: the four `scanFabHidden` rules incl. the REG-B62 pricing-ready gate),
  `barcode-fab-props.test.ts` (type-level, `tsc --noEmit`: `BarcodeFab`'s handler union rejects
  neither-handler and both-handlers, accepts either alone — L-095), `scan-camera-web-sequencing.test.ts`
  (B245 pin, outside this run's red gate: 5 source-text assertions on
  `ScanCamera.web.tsx`'s own adapter wiring — `handleFrame` in `.then()`, `inFlightRef` release in
  `.finally()`, the `scanSettled` drain, `playScanCue`, `track.stop()` on unmount — discharges B245
  as a coverage pin, not a behavioral fix, L-025). **Retitled `REG-B245: …` in #671 (2026-09-08,
  commit `76c80b00`, docs/F16b-invoice-counter's sibling test-hygiene fix)** — the registry's
  `proof: REG-B245` field predated a matching literal token in the test titles themselves (the
  discharge on #668 was correct in substance, just not campaign-check-checkable byte-for-byte
  until this retitle); no assertion changed. L-097.
- **#675 (2026-09-08, B263 option B):** `price-override.test.ts` (REG-B263-A, pure: `applyPriceOverride`
  rounds via `roundMoney`, preserves boxes/pieces/freeUnits, recomputes `lineTotal`; `needsMarginAck`
  true/false at the floor boundary; source pin that the list-branch `PriceOverrideModal` routes through
  `applyPriceOverride` and no longer writes `unitPrice: newPrice` directly), `edit-items-scan-price.test.ts`
  (REG-B263-B, source-text: exactly one `<PriceOverrideModal` mount inside the picker branch, its
  `<BarcodeScanner` carries `active={!pickerPriceEditItem}`, `onSave` wired through
  `applyPriceOverride`; REG-B263-H, round-3 light-loop: the picker strip's margin-floor label derives
  from the same `computeMarginFraction`/`classifyMargin` calls `DraftItemCard` uses, regex-pinned
  against the list row's own message literals; `PIN-B263-D4`, no-change regression: list-branch
  `canEditPrice` gating untouched), `barcode-scanner-active.test.ts` (REG-B263-C, source-text,
  comment-stripped: both `BarcodeScanner.tsx` and `.web.tsx` forward `active` into `<ScanCamera` and
  render `feedback.action` bound to `action.onPress`).
- mocks: `@routeflow/ui.js`, `@routeflow/types.js`, `expo-secure-store.js`.

### Batch 2026-07-23 (PRs #306, #307, #309, #310)

- **Line-field preservation (#306)** — `lib/sale-line.ts` gains pure `decrementLine`/`setLineQty`/`setLineBoxes`/`setLinePieces` counterparts to `incrementLine`, all spreading `...prev` so `unitPrice`/`note` survive. Rewired the rebuild-style setters that dropped them: `NewOrderScreen.tsx` `setQty`/`setBoxes`/`setPieces`/`removeOne` and `(operator)/(tabs)/invoices/new.tsx` `removeOne`. Tests in `__tests__/sale-line.test.ts`. **2026-07-30, WP6:** `lib/sale-line.ts` gains pure `setLineUnits(prev, units, unitsPerBox)` — sell-by-unit entry: normalizes a TOTAL unit count back into `{boxes, pieces, qty}` (7 units of a 6-pack → 1 case + 1 loose), `null` when `unitsPerBox` isn't > 1 or the total is 0. Backs a new Cases/Units segmented control (`SellByToggle`, local to each screen) on case-packed lines in `NewOrderScreen.tsx` (product row + `CartRow`, via `setUnits`/`setSellBy`) and `edit-items.tsx` (`DraftItemCard`, via `setUnits`/`setSellBy` — `DraftItem`/`LineState` both gained a UI-only `sellBy?: "case"\|"unit"` field, never sent in the diff/payload). Units mode's `QtyStepper`/`StepperRow` has **no `max`**. "Boxes"→"Cases", "Loose pcs/pieces"→"Loose units", and "box of N"→"case of N" relabeled throughout both files' case-packed line UI. Per-unit hint (`≈ $X.XX/unit`) added next to case prices via WP2's `perUnitPrice` from `lib/pricing.ts`. Tests extended in `__tests__/sale-line.test.ts`.
- **Typed quantity input (#307)** — new `components/QtyStepper.tsx` (`QtyTextInput` primitive + bordered `QtyStepper` md/mini) built on new pure `lib/qty.ts` `commitQtyDraft` (empty→0 or revert, below-min revert, above-max clamp-no-rollover). Wired into the 4 tap-only surfaces: `NewOrderScreen` tile + boxed dual, `invoices/new` (new `setUnits` helper, `suffix` "b + N"), `(customer)/orders/cart.tsx` + `(customer)/(tabs)/catalog.tsx` (cartStore `setUnits` action); opportunistic upgrade of customer `orders/[id]/edit-items.tsx`. Tests: `qty.test.ts` `commitQtyDraft`, `cart-store.test.ts` `setUnits`.
- **Payment image (#309)** — `lib/api/payments.ts`+`invoices.ts` mirror the 3 image fields + upload/get/delete hooks; operator `record-payment.tsx` + driver `route/stop/[stopId]/payment.tsx` capture via `PhotoCapture` (HEIC→JPEG transcode, best-effort upload to `createdPaymentId`/`paymentIds[0]`); `invoices/[id].tsx` payment rows + edit screen view/replace/remove.
- **Unit code (#310)** — `lib/product-form.ts` + `components/ProductForm.tsx` add the "Unit code" field; `lib/barcode-resolve.ts` exact-preference widened to `unitSku`. Scan screens unchanged (server widening covers them).

### Batch 2026-08-10 — mobile-web scan + catalogue defects

Five owner-reported defects, all reproducing on **mobile web** (react-native-web behind the
phone-UA proxy), plus a latent totals bug found on the way.

- **Row collapse — `lib/row-layout.ts` (new).** RNW renders `<TextInput>` as a real `<input>` with
  no declared width, so it carries the UA `size=20` intrinsic (~177px); the stepper pill is
  `flexShrink: 0`, so it balloons and starves the sibling name column until `word-wrap: break-word`
  renders text one character per line. **`minWidth: 0` and `flexShrink: 1` are inert here** — RNW's
  `View` base already sets `minWidth: 0`, and no deficit reaches the input. Only a DEFINITE `width`
  works. `QTY_INPUT_WIDTH` {md 52, mini 46, cart 60, edit 56} + `MONEY_INPUT_MAX_WIDTH` 96 are
  consumed by `QtyStepper.tsx` (md/mini), `NewOrderScreen` `cartStepperInput`/`cartPriceInput`,
  `invoices/new` `cartPriceInput`, and `edit-items` `qtyInput` (hand-rolled stepper duplicate —
  worth folding into `QtyStepper` later). Unclamped `<Text>` in every row got `numberOfLines`.
  `+html.tsx` adds a `min-width: 0` net for _unstyled_ inputs (does NOT fix the steppers).
  `SearchBar` (packages/ui) gains `minWidth: 0`. Guard: `__tests__/row-layout.test.ts`
  (`stepperPillWidth`/`textColumnWidth` arithmetic; fails on a revert to `minWidth`-only).
  `removeClippedSubviews` gated to `Platform.OS === "android"` — RN's own default; it is a **dead
  prop on RNW**, so this is a native-only hygiene fix.
- **Forgiving barcode matching — `lib/barcode-normalize.ts` (mirror of
  `apps/api/src/common/barcode-normalize.ts`).** `normalizeScanCode` → ordered candidates (UPC-E→
  UPC-A, UPC-A↔EAN-13, GTIN-14 unwrap, leading-zero strip, check-digit-stripped LAST),
  `upcEToUpcA`, `pickBestScanMatch`. Mobile's copy exists only for the in-memory scan fast path in
  `NewOrderScreen`/`invoices/new` (which now also check `unitSku`). Drift guard:
  `__tests__/barcode-normalize.test.ts` compares both files below the header.
  `lib/barcode-resolve.ts` gains additive `ambiguous`/`matches` — >1 substring hit no longer
  silently adds row #1.
- **Scanner survives a miss — `lib/scan-loop.ts` `ScanFeedback.action`.** On RNW, sibling `Modal`
  portals stack by mount order with **no z-index**, so the root `ConfirmModal` rendered BEHIND the
  opaque scan sheet — which is why the miss path returned `{close:true}` and the first mis-read
  stranded the operator. Now the miss returns an actionable pill; `ScanOrderSheet` gains
  `paused` (freezes decoding without tearing the stream down) and an 8s action pill.
  `scanOpen` is never cleared, so create/cancel both land back in a live scanner.
  **`InlineCreateProductSheet` must stay AFTER `ScanOrderSheet` in the JSX** (portal order).
  `invoices/new` also gained the missing `canCreateProducts` role gate.
- **Scan affordances** — `CartModal` gains `onScanMore` (inverse of `onReview`); `edit-items`
  `ProductPicker` gains a `trailing` barcode button + single-shot `BarcodeScanner`.
- **Web camera — `ScanCamera.web.tsx` rewritten.** One throttled ~15fps loop with an in-flight
  guard replaces the per-rAF `detect()` and zxing's `decodeFromStream` (whose
  `delayBetweenScanAttempts: 500` default meant **2 attempts/sec on iOS**, where zxing is the only
  decoder). Adds a 3-step `getUserMedia` ladder (1080p + `focusMode`), torch via
  `getCapabilities().torch` (Android/Chrome only — iOS exposes none), a `getSupportedFormats()`
  gate (its absence could leave the camera streaming and never decoding), zxing
  `POSSIBLE_FORMATS` + `TRY_HARDER` (needs new dep `@zxing/library`), a centre-band ROI on the
  zxing path only, and ITF-14. Fixes two loop bugs (permanent death on a transient null ref;
  re-arming against a dead stream) and drops the dead `reader.reset()`. `ScanCamera.tsx` gains
  `enableTorch`/`autofocus`/`itf14`. `ScanOrderSheet` adds `navigator.vibrate` (web had no scan
  confirmation at all).
- **Paged catalogue + live suggestions — `lib/use-product-search.ts` (new).** Replaces five
  hand-copied `limit: 0` fetch-alls. `useProducts` gains an options arg, `isActive` in the query
  key, and baked-in `placeholderData: keepPreviousData` (the blanking that read as "no
  suggestions"); new `useProductsInfinite` (50/page). Pure helpers `lib/paged-rows.ts`
  (`flattenPages` with page-boundary de-dupe, `mergeProductIndex`) and
  `lib/product-search-params.ts` (`productSearchParams` — a live term drops the hidden category
  chip — `nextProductPage`). Category filtering moved SERVER-side; chips now come from
  `useProductCategories()`. Converted: `NewOrderScreen`, `invoices/new`, `edit-items`
  `ProductPicker`, `recurring-invoices/new`. **NOT converted:
  `regulated/[id]/assign-products.tsx` — its `limit: 0` is load-bearing** (seeds the assigned set
  from the whole catalogue; paging would unassign unloaded products on Save).
  **Lazy-gated catalogue load (2026-09-14, owner ask) — the catalogue now fetches only on a term
  or a deliberate "Browse catalogue" tap, never on mount.** `lib/product-search-params.ts` gains
  `ProductSearchParams.scanCode?` (set instead of `search` when `looksLikeScanCode(term)` —
  `products.service.ts findAll` treats `search`/`scanCode` as mutually exclusive and expands
  `scanCode` against every `normalizeScanCode` candidate, which a literal ILIKE on `search`
  cannot match for a decoder-mismatched barcode) and `productSearchEnabled({term, browsing,
enabled})` (a VETO: `enabled:false` always wins; otherwise a term or `browsing:true` is
  required — the shared gate every picker below now applies). `useProductSearch` gains
  `opts.browsing` + a `ProductSearch.idle` flag (fetch gated off — render an idle empty state,
  not "no matches"); new sibling **`useAdminProductSearch<T>`** built on `lib/api/admin.ts`'s
  `useAdminProductsInfinite` (now `enabled`-gated) for the `AdminProduct`-shaped pickers —
  `ProductPickerSheet` needs archived rows for several callers (`activeOnly` prop), which
  `useProductsInfinite` cannot serve (hardcodes `isActive:true`). Converted to the gated pattern:
  `edit-items.tsx`, `NewOrderScreen.tsx`, `invoices/new.tsx`, `ProductPickerSheet.tsx`,
  `recurring-invoices/new.tsx`'s `ProductPickerModal` — each renders an idle "Browse catalogue"
  affordance instead of the full list on open. `lib/api/products.ts useProductsInfinite` params
  gain `scanCode?`; `lib/api/admin.ts useAdminProducts`/`useAdminProductsInfinite` both gain an
  `options?: {enabled?}` second arg. Specs: `__tests__/picker-idle.test.ts`.
- **"ON THIS ORDER" mode** — `orderOnly` state on both sale builders: after a scan the list shows
  only the order's lines, newest scan first, with a _Show all items_ escape in the chip row's slot.
  Exits on typing, the toggle, or the order emptying. Deliberately does NOT put the scanned code
  in the search box: `search` doesn't cover `Product.id` and `/products/barcode/:code` resolves
  codes the text search can't, so a successful scan could leave an empty list.
- **Latent totals bug (fixed)** — `addOne`'s snapshot stash was gated on `productSnapshot`, which
  only the scan path passes. A row added by TAPPING was never retained, so `productById` lost it
  once the page changed and the **footer total silently under-reported**. Now unconditional in
  both builders. Guard: `__tests__/paged-rows.test.ts` `mergeProductIndex`.

### Batch 2026-08-11 — persistent operator bottom nav

- **The bar now lives in `app/(operator)/_layout.tsx`, not in the tab navigator.** It used to be
  drawn by `(tabs)/_layout.tsx`, but that layout is one _screen_ inside the operator `<Stack>` — so
  the ~88 operator routes outside `(tabs)/` (credit-notes, payments, new-order, products,
  customers, vendor-bills, …) covered it when pushed. `(tabs)/_layout.tsx` now passes
  `tabBar={() => null}` so exactly one bar exists.
  **Rendered as a plain in-flow flex sibling of `<Stack />`, NOT an overlay** — `<Stack>` carries
  `flex:1` on both platforms, so the viewport is simply ~57px + inset shorter and **no screen needs
  bottom padding**. Same shape as the `OfflineBanner` above it, and as React Navigation's own
  `BottomTabView`. Routing is untouched: no file moves, no import rewrites, 176 nav call sites and
  106 `router.back()` calls unaffected.
- **`components/OperatorTabBar.tsx`** — up to five destinations, built from
  `visibleOperatorTabs(useRoutesAccess().enabled || useDeliveryAccess().enabled)` (Dispatch is
  addon-gated by EITHER delivery feature — see "recurring-routes / order-delivery addon split"),
  active state from `lib/operator-tabs.ts` `activeOperatorTab(useSegments())`.
  **The press action is load-bearing and was verified in a browser, not deduced.** It is
  `navRef.dispatch(StackActions.popTo("(tabs)", { screen: tab }))`, dispatched **UNTARGETED** via
  the container ref, preceded by a targeted `popToTop` on the destination tab's own nested stack
  (`lib/operator-tab-nav.ts` `findDeepTabStackKey`) to preserve pop-to-root. Do **not** swap in
  `router.push/replace/navigate/dismissTo`: expo-router targets the deepest DIVERGING navigator, so
  from off-tab REPLACE inserts a _second_ `(tabs)` route (unbounded stack growth), and from inside
  `(tabs)` the TabRouter implements neither REPLACE nor POP_TO and a targeted unhandled action is
  swallowed silently. Verified: cold deep-link with no `(tabs)` mounted, off-tab screen, other tab,
  same tab, and 7 rapid taps — the operator stack holds exactly one `(tabs)` throughout.
- **`tabPress` is dead now** (it is only ever emitted by a tab bar). The five `popTabToRoot`
  `listeners={…}` blocks were deleted rather than left as dead code; pop-to-root moved into the bar.
  The `<Tabs.Screen>` entries stay — they still carry titles, icons and `finance`'s `href: null`.
- **Pure, spec'd seams:** `lib/operator-tabs.ts` (`activeOperatorTab`, `OPERATOR_TABS`,
  `OPERATOR_TAB_ROOT`, `visibleOperatorTabs(dispatchAccess)`; unmapped sections fall back to **More**,
  which is the hub they're reached from) and `lib/operator-tab-nav.ts` (`findDeepTabStackKey`). Specs
  `__tests__/operator-tabs.test.ts` + `__tests__/operator-tab-nav.test.ts`.
- **No deny-list — the bar shows on every operator page**, including new-order and the inline
  scanner screens. Footer-over-bar is already shipped: `invoices/new` and `orders/[id]/edit-items`
  are inside `(tabs)` today, and `NewOrderScreen` already renders under the _driver_ bar. Measured
  on new-order at 375px: Confirm 676-696, Save-as-draft 718-734, bar label 790 — nothing clipped.
- **Companions:** `components/FormSheet.tsx` gains `bottomInset` (default OFF — sheets now sit above
  a bar that already owns the inset; `(customer)/sellers/connect.tsx` is the one consumer with no
  bar below it and opts in). `lib/toast.ts` web toast moved from `bottom:32px` to `96px` to clear
  the bar. **2026-09-14:** `warnIfDirty` renamed `confirmDiscardIfDirty` (now also gates an in-app
  discard confirm, not just web `beforeunload`) — see `mobile/tests-2.md`'s "2026-09-14 —
  hunt-mobile-scan lanes A-E" §Lane C.

### 2026-08-11b — scan-to-order realigned with web

Owner: _"adding items by scanning to an order should behave exactly in the way the desktop website
behaves… no messes, avoid clutter, super efficient."_ The **"ON THIS ORDER" mode added in
`5be1dfac` is REVERTED** — it was a mobile-only invention with no web counterpart, and it was the
clutter. Removed from both sale builders (`NewOrderScreen.tsx`, `(tabs)/invoices/new.tsx`):
`orderOnly` state, the `orderRows` memo, the auto-exit effect, the bar that replaced the chip row,
and its `onEndReached`/footer gates.

**The invariant to hold on to: a scan must not move the catalogue.** Web increments a repeat scan
IN PLACE (`CreateOrderModal.addLineItem`, `orders/[id]/page.tsx addProduct`) and never filters or
re-sorts. So `scanOrder`/`bumpScanOrder` still drive the scan TRAY's newest-first order — the
phone's stand-in for web's always-visible line table — but must never reach `filtered`.
`requestScroll` is now skipped while `scanOpen` (it was animating a list behind an opaque modal).
Verified in-browser: scanning FIX-3, FIX-1, FIX-3 left the catalogue alphabetical and untouched,
chips visible, 3 items / $40.49 (repeat incremented in place).

**Two deliberate NON-copies of web, both money-safety:**

- Web's create-order flow silently takes `matches[0]` on a multi-match. Mobile keeps its
  `ambiguous` guard, because this tenant has numeric product NAMES so a 12-digit scan
  substring-matches broadly and the guess would put the wrong item on an order. Web's order-EDIT
  screen agrees (it opens a picker). "Choose" now opens `ProductPickerSheet` (new `initialSearch`
  prop) over the **paused** camera instead of tearing it down — one tap, scanning resumes.
- `ScanOrderSheet` + `ScanTray` stay. Web needs no tray because its line table is permanently
  beside the search box; a full-screen phone camera hides everything, so the tray restores that
  property. Deleting it would make mobile worse than web, not equal.

**Known remaining divergence (not fixed):** `orders/[id]/edit-items.tsx`'s picker scanner is
single-shot — its contract is "return one product", so `onPick` closes it. Web's edit screen
re-focuses its input and scans N items with zero taps. Closing the gap needs an add-and-stay
callback; commented in place at the `onScanned` docblock.

### Wave 1 2026-08-11 — order-builder row UX (mobile-first program)

Owner declared mobile the PRIMARY surface. Principle set: **every-line actions live on the row;
exceptions live one tap behind it. One affordance per action.**

- **`components/BoxedQtyBand.tsx` (new)** — inline Cases + "Loose {unit}" mini steppers on band
  line 1 (two 104px pills + gap = 218px, fits the 268px band at the 320px floor); summary + Edit
  chip on band line 2 via a wrapper with `flexBasis: "100%"` (basis on the Text alone pushes the
  chip to a third line — geometry asserted in `__tests__/row-layout.test.ts`, constants
  `bandInnerWidth`/`BAND_GAP`/`BAND_EDIT_CHIP_WIDTH` in `lib/row-layout.ts`). Loose stepper
  mirrors the sheet's `max = unitsPerBox - 1`. Consumed by BOTH sale builders; each wires
  `setPieces` through its existing `actionsRef` stable-identity pattern. Loose pieces previously
  cost a Review-sheet round-trip; desktop always had them inline.
- **`lib/boxed-line-summary.ts` (new)** — the formerly copy-pasted summary, now
  `(line, unitsPerBox, unitPrice)` with a RESOLVED price number (the builders resolve price
  differently: tier-aware vs not). Spec pins strings AND a latent sharp edge: a boxed line with
  qty but NO split would hit computeLineSubtotal's per-piece fallback (case price × pieces) —
  unreachable today because every sale-line helper writes the split; do not normalize in the
  summary without normalizing the footer too (row-vs-footer agreement is the invariant).
- **`components/SellByToggle.tsx` (new shared)** — canonical bgElev + hairline track,
  `alignSelf: "flex-start"` (both call sites are columns; stretch pulled the old NewOrderScreen
  copy full-width). edit-items' borderless fill3 copy deleted.
- **Footer: ONE control.** The summary chip (brandWash, eyebrow "N ITEMS" + chevron-up, bold
  total, splitBadge inside) IS the review button; "View / edit" deleted from both builders. The
  chevron sits on the eyebrow line so the 24px total governs chip min-width ($99999.99 unclipped
  at 320). Zero items → washless + disabled. Confirm is now the only right-side child.
- **Verified in-browser at 320/375/390** on both builders with a new `E2E Case Pack` fixture
  (upb 6, $12/case, sku E2E-CASEPACK-1) created on e2e-routeflow: steppers share line 1, summary
  line 2 (280px @390), Loose + → "1 case + 1 loose · $14.00", typed 9 clamps to 5 → $22.00
  (= 12 × 11/6), chip opens the sheet with price/SellBy/note/cost intact, no horizontal scroll.
- **Roadmap:** Waves 2-6 (invoices money-complete → payments at the door → customer file →
  catalog & supply → visibility) live in the plan; the parity audit found ALL top-15 gaps are
  UI-only (endpoints exist; some mobile hooks exist unused).

### 2026-08-11c — order mutations invalidate BOTH cache families

Owner: "when I delete an order, it does not disappear immediately." Root cause: order data lives
under TWO query-key families — driver/customer surfaces read `["orders", …]`, the OPERATOR
list/detail (`useAdminOrders`/`useAdminOrder`, 30s staleTime) read `["admin","orders", …]` — and
most mutations in `lib/api/orders.ts` invalidated only `["orders"]`. Three had been hand-patched
with both; delete/cancel/create/urgent/status hadn't. All 11 now route through one
`invalidateOrderCaches(qc)` helper (two prefix invalidations cover every per-id key too — do NOT
hand-roll the pair again, that's how they drifted). Driver change-request resolve/decline in
`lib/api/change-requests.ts` got the same admin-family addition. Verified in-browser on
e2e-routeflow: created ORD-00006 (appeared in the list instantly — create had the same bug),
deleted it, list back-navigation showed it gone with zero refresh. Invoices were already correct.

### Wave 2 2026-08-12 — invoices money-complete (mobile-first program)

Gap #1 from the parity audit: any taxed/discounted invoice was redone on a laptop. All server
DTO fields + five lifecycle endpoints are now first-class on mobile (contract details on the
Invoices row above).

- **`lib/invoice-totals.ts` (new)** — `computeInvoiceTotals` mirrors the SERVER formula
  (invoices.service.ts:202-287): per-line `roundMoney(computeLineSubtotal − discount)`, tax =
  `roundMoney(Σ lineSub × taxRate)` on POST-discount lines, invoice discount AFTER tax, shipping
  untaxed, `isTaxExempt` zeroes tax (web's create preview gets exempt + rounding wrong; the
  builders here match the saved invoice to the cent). Regulated category-tax is the known,
  web-shared preview gap. Plus `invoiceLineDto` (wire serializer; forbidNonWhitelisted-safe:
  never leaks `taxable`/`unitsPerBox`, drops the split for productless lines, taxable→taxRate
  exactly like web). Spec `__tests__/invoice-totals.test.ts`.
  **BUY_N_GET_M (2026-08-21):** `InvoiceTotalsLine.freeUnits` feeds `computeLineSubtotal`, and
  `editedLineFreeUnits({promoFreeUnits, promoBaseUnits, boxes, qty})` rescales the order line's
  snapshot when the operator changes the qty (proportional at the earned rate, never above the
  agreed snapshot, capped at `units - 1` — no line is entirely free; BOXES, never loose pieces).
  `invoiceLineDto` serialises `promoFreeUnits` when non-zero: the items PATCH replaces every
  line, so dropping it re-prices an agreed $350 line to $420.
- **`lib/invoice-terms.ts` (new)** — TERM_DAYS/TERM_CHIPS/DEFAULT_TERMS/ISO_DATE/`dueDateFor`
  extracted from `invoices/new.tsx` + `SplitInvoiceScreen.tsx` dupes. Spec
  `__tests__/invoice-terms.test.ts`.
- **Builder `(tabs)/invoices/new.tsx`** — ReviewRow gains flat-$ Discount, Taxable checkbox
  (tenant `useBusinessSettings().taxRate` % → fraction; hidden when rate 0 or customer exempt
  via `useAdminCustomer(customerId).isTaxExempt`), and a per-line note (NewOrderScreen's
  note/noteOpen pattern — extra LineState fields survive the sale-line helpers' `...prev`).
  Details card gains reference/subject/invoice-discount/shipping-fee (`detailMoneyCol` uses a
  flexBasis:0 split — RNW input intrinsic width). Review footer shows the
  subtotal/tax/discount/shipping breakdown only when one applies; footer/scan-tray totals are
  the grand total. Unlisted rows: Taxable only (price is already free-entry).
- **Edit screen `(tabs)/invoices/[id]/edit.tsx` (new)** — DRAFT-only FormSheet mirroring web's
  edit page: hydration keeps web's rules (split only when `boxes != null`, SALE-TIME unitsPerBox
  snapshot, qty in total pieces); per-line price/cases/loose/discount/taxable/note; historic
  taxRates round-trip un-restamped (`rateFor`); per-line notes ALWAYS round-trip (items PATCH =
  delete-and-recreate). So does the BOGO snapshot (`promoFreeUnits`/`promoBaseUnits`
  on `EditLine`, hydrated from `AdminInvoice.items[].promoFreeUnits`, re-derived through
  `editedLineFreeUnits` for the totals, the line card and the DTO) — that one is MONEY. Add via `ProductPickerSheet` or blank in-place-editable unlisted cards.
  Guard screens: non-DRAFT ("revert to draft first") and `isPendingOrderMirror`.
- **Detail `(tabs)/invoices/[id].tsx`** — tiles gated by `invoiceActionFlags`: Edit, Send
  reminder (email pre-checked, passes it explicitly like web), Apply credit (net-new
  invoice-side `ApplyCreditSheet` — mounted only while open so its `useCreditNotes({customerId,
status:"ISSUED"})` never runs unscoped; filters via `isCreditOpenForApply`; full apply,
  surfaces the four actionable server rejections verbatim). Duplicate/Revert/Reopen/Unvoid sit
  behind ONE More tile → `chooseAction` (web parks these in its "..." menu for the same reason).
  Header shows subject + reference; item rows explain per-line discounts.
- **Types** — `AdminInvoice` + `deliveryBatchId`/`referenceNumber`/`subject`/`terms`/`notes`,
  items + `discount`/`taxRate`/`productId`; `AdminCustomer` + `isTaxExempt` (all
  already-returned-just-untyped).
- **`app/(operator)/settings/index.tsx`** — tax-rate field hint corrected to "%, e.g. 8.75":
  `settings.taxRate` is a PERCENT (web validates 0-100 and every consumer divides by 100); the
  old "(e.g. 0.0875)" hint told owners to store a fraction that web then divided again.

### 2026-08-12b — scan-miss fix + clear-on-pick (owner-reported)

- **Scan fallback is candidate-aware**: `lib/barcode-resolve.ts`'s search rung sends
  `scanCode=<raw>` — the SERVER fans normalizeScanCode candidates into the contains-match
  (`apps/api/src/products/scan-search.ts`), closing the "iOS decodes 13 digits but the 12-digit
  code lives in the product NAME" miss. The two barcode-normalize mirrors are UNTOUCHED (the
  drift test byte-compares them; server-only helpers must live elsewhere).
- **Clear-on-pick**: both sale builders' `rowActions.pickedFromSearch(id)` clears the search and
  pending-scrolls to the added row — fired from `onRowAdd` ONLY (first add; stepper increments
  never swap the list mid-repeat-tap). Camera scanning was already continuous — untouched.
- **`packages/ui` SearchBar** — cross-platform clear X (`accessibilityLabel="Clear search"`),
  gated `Platform.OS !== "ios"` (native iOS already renders `clearButtonMode`'s X; RNW/Android
  previously had NO one-tap clear at all).

### Wave 3 2026-08-12 — payments at the door (mobile-first program)

- **MSRP display (2026-08-22, PR-B — ⚠️ IN FLIGHT on `feat/msrp-on-invoices`, NOT on master)** —
  read-only mirror of web's invoice sub-line: `InvoiceItem.msrp` in `lib/api/invoices.ts`, rendered
  as a muted `MSRP $X.XX/pc` under the `qty × price` line on `(operator)/(tabs)/invoices/[id].tsx`
  and `(customer)/invoices/[id].tsx`. Gated on `item.msrp != null`, not on the addon flag. **v1 is
  display-only on mobile** — no MSRP editing here (product form and the per-customer override stay
  web-only); MSRP is per PIECE and never enters money math, so `@routeflow/pricing` is untouched.
  Nullable-tier sweep (2026-08-22): `lib/api/customers.ts` `CustomerPrice.pricingTier` is
  `number | null`; the three cart cpMaps (`orders/[id]/edit-items.tsx`, `invoices/new.tsx`,
  `NewOrderScreen.tsx`) are `Map<string, number | null>` (consumption `?? customerTier ?? 1` was
  already safe); `customers/[id]/catalog.tsx` now loads `useCustomer` for the default tier — an
  msrp-only row shows a "Default" badge and prices at the customer's default tier instead of
  passing `null` into `getTierPrice` (which silently priced at list). The edit modal is null-aware
  too: tier state is `number | null` seeded `existing.pricingTier ?? null` (⚠️ the old `?? 1` seed
  silently converted an msrp-only row into a Tier-1 override on save — review-confirmed money bug),
  with a "Default" chip offered only when the row keeps an MSRP (`allowNoTier`); new overrides
  still require a tier, and tier-only rows can't be nulled from mobile (that would be a server-side
  delete — mobile deletes via the trash icon only).
- **`lib/payment-methods.ts`** (new 2026-08-21) — **THE single source for payment-method lists in
  mobile.** `SELECTABLE_PAYMENT_METHODS` (`CASH,CHECK,ZELLE,ACH,CREDIT_CARD,OTHER`),
  `SELECTABLE_METHOD_OPTIONS` (`{id,label}[]`, ready for the chip rows every payment screen
  renders), `ALL_PAYMENT_METHODS` (+`CREDIT_NOTE`,`ADVANCE` — display only, server rejects them
  on record), `PAYMENT_METHOD_LABELS`, `paymentMethodLabel()`. Created when Zelle was added: four
  screens each hand-rolled a `METHODS` array and had drifted apart (`record-payment.tsx` offered
  only CASH/CHECK/ACH). **Never re-declare a method list — import from here**; mirror is
  `apps/web/lib/payment-methods.ts`, source of truth is the Prisma `PaymentMethod` enum.
  The two **expense** screens (`(operator)/expenses/{new,[id]}.tsx`, whose free-form
  `Expense.paymentMethod` column is NOT the enum) also consume it now, so they match their web
  twins; each keeps a local `methodLabel()` = `PAYMENT_METHOD_LABELS[m] ?? title-case`, the
  fallback rendering rows still holding the retired mobile-only `CARD`/`BANK_TRANSFER` spellings.
  **One deliberate exception:** the driver at-door screen `route/stop/[stopId]/payment.tsx` keeps
  its own `METHODS` (`Cash,Card,Cheque,Zelle,Account`) — driver vocabulary, and it must offer
  ADVANCE ("Account" = on account) which is never in `SELECTABLE_PAYMENT_METHODS`. It maps
  label→enum locally and must be extended by hand for every new method (Zelle added 2026-08-21).
  Labels must stay short: the `SegmentedControl` segments are `flex: 1`, so five of them leave
  ~60pt of text width on a 375-390pt phone (that is why it is "Account", not "On account").
  The two client unions are now aliases of it (names kept, widely imported):
  `lib/api/invoices.ts` `PaymentMethod = AnyPaymentMethod` and `lib/api/payments.ts`
  `EditablePaymentMethod = SelectablePaymentMethod` (the latter also feeds
  `lib/api/supplier-payments.ts`).
- **`lib/payments-logic.ts`** — + `CHECK_TRANSITIONS` (server mirror; null stored status =
  RECORDED) + `checkNextStates` (CHECK & not-VOID only); `waterfallAllocations` /
  `allocationTotals` / `oldestInvoicesFirst` — the standalone endpoint applies allocations
  VERBATIM (no rounding, no per-invoice cap, no sum≤total guard, `PAY-####` numbers lack the
  tenant hash), so ALL safety is client-side. Specs extended (32 cases). `paymentMethodPill` is a
  hand-written switch (variant+label+**Ionicon**, which the shared labels map can not supply) — it
  must gain a `case` for every new method or the `default` silently renders it as grey "Other";
  `ZELLE → purple/"Zelle"/flash-outline` added 2026-08-21.
- **`lib/api/payments.ts`** — `useRecordPaymentStandalone` (`POST /invoices/payments/record`;
  excess>0.001 → AdvancePayment), `useSetCheckStatus` (+`settledAt`, which web's DTO omits);
  `AllPayment` + check columns (always on the wire, previously untyped).
- **`lib/api/customers.ts`** — `AdvancePayment` (wallet = `balance`; used = amount−balance, NO
  amountUsed column) + list/create/apply hooks. Advance routes are `@Body dto:any` server-side —
  zero validation; apply's INLINE status recompute loses DRAFT-is-terminal, so apply-advance UI
  gates to SENT/VIEWED/PARTIAL/OVERDUE.
- **`payments/record.tsx` (new)** — customer pick → amount/method chips → oldest-first waterfall
  over open invoices (client-side OPEN_STATUSES + balanceDue>0 filter — ListInvoicesDto.status
  takes ONE enum value; the comma list web's modal sends 400s silently), rows capped at
  balanceDue, Allocated/Received/Unallocated strip (excess → advance), save-as-draft toggle,
  receipt photo (HEIC→JPEG vs payments[0].id). Submit blocks on over-allocation.
- **`payments/index.tsx`** — '+' Record entry (NavBar trailing), method chips (7), check badge
  replaces the method pill on check rows, load-more (`meta.total`). Deferred deliberately:
  date-range/customer filters + CSV export (desktop chores).
- **`payments/[id].tsx`** — check badge + deposited/cleared/bounced KV rows; Mark deposited
  (confirm) / Mark cleared (optional bank-date → settledAt) / Mark bounced (NSF-fee modal:
  voids the row, re-opens the invoice, non-taxable fee line + stored-total bump server-side).
- **`(tabs)/invoices/[id].tsx`** — `ApplyAdvanceSheet` (wallet rows balance>0; first client for
  this action — web's `useApplyAdvanceToInvoice` is dead code). **`customers/[id].tsx`** —
  Record-advance modal + "Record advance payment" row in Account standing.

### PR-D 2026-08-20 — generic → variant stock assignment (first mobile variants UI)

- **`lib/variant-split-logic.ts` (new)** — pure sheet math, node-testable: `resolvedRowQty` /
  `remainingPool` / `clampToAvailable` / `applyRowQtyChange` (a boxed edit is clamped as a TOTAL
  then re-split via `normalizeBoxesPieces`, so the two fields never disagree) and
  `buildVariantAssignPayload` → `POST /inventory/variant-assign` (drops 0-qty and unnamed
  new-variant rows; null when nothing survives). `SplitRow.unitCostText` is **raw text, never a
  number** — a controlled input backed by a number eats the decimal point on every keystroke
  ("2." → 2 → "2"), which made a $2.75 override untypable; `parseCostText` parses ONCE at submit
  (4dp via `roundUnitCost`; blank/non-numeric/negative → inherit the parent's average). Mirrors
  web's `RowState.cost: string`. Specs: `__tests__/variant-split-logic.test.ts`.
- **`components/VariantSplitSheet.tsx` (new)** — FormSheet-pattern modal, one row per active
  variant + one inline new-variant row, live "Remaining: N", in-screen success (mobile has no
  toast action slot; movements link is by `productId`, never `?reference=`). Boxed parents render
  `BoxedQtyBand`; **its `unitPrice` must be case-denominated** (`rowUnitCost * unitsPerBox`) —
  every cost here is per BASE UNIT but `boxedLineSummary`/`computeLineSubtotal` bill per CASE.
  STANDARD-costed parent ⇒ no cost affordance at all (`onEdit` omitted, plain-row toggle hidden),
  matching web dropping the whole Cost column.
- **`components/BoxedQtyBand.tsx`** — `onEdit` is now **optional**; omitting it drops the Edit
  chip entirely rather than rendering a chip that does nothing. Both sale builders still pass one.
- **`lib/api/variant-assign.ts` (new)** — `useAssignToVariants()`. Entry point:
  `app/(operator)/products/[id].tsx` Stock card ("Unassigned stock: N" + "Assign to variants",
  only when the product has variants and no parent).

### PR-E 2026-08-20 — AP payment allocation (supplier) + customer payment entry point

- **`lib/supplier-payment-logic.ts` (new)** — pure AP waterfall math, the mirror of
  `lib/payments-logic.ts`'s AR side: oldest-bill-first ordering, greedy pre-fill, per-row
  clamping and remainder. Eligibility is **`totalOwed − totalPaid > 0.001`, never
  `VendorBillStatus`** — PARTIAL is written both for a SHORT RECEIPT and for a part payment, so a
  short-received bill with `totalPaid = 0` is fully allocatable. Specs:
  `__tests__/supplier-payment-logic.test.ts` (18).
- **`components/RecordSupplierPaymentSheet.tsx` (new)** — FormSheet allocation sheet; every row
  editable before confirm, remainder shown as "stays on account".
- **`lib/api/supplier-payments.ts` (new)** — `useRecordSupplierPayment`
  (`POST /vendor-bills/payments/record`) + `useSupplierStatement`
  (`GET /vendor-bills/suppliers/:supplierId/statement`), both registered ahead of the `:id`
  routes in `vendor-bills.controller.ts`. ⚠️ The statement response is **`timeline`, not `rows`**,
  each entry keyed `description` (not `label`) with a **SIGNED** `amount` (BILL +,
  PAYMENT/CREDIT −) — types mirror web's `lib/api/supplier-payments.ts`. A SupplierCredit
  draw-down is folded into the bill's `totalPaid` and omitted as its own row (not new money), so
  PAYMENT rows are real cash only. Unlike the AR standalone endpoint the server DOES validate:
  wrong-supplier bill, over-bill allocation and `Σ allocations > totalAmount` each 400 + roll back.
- **`(operator)/suppliers/[id].tsx`** — "Account standing" card: outstanding / owed / paid /
  account-credit tiles, "Record payment", and a most-recent-first 8-row activity feed off
  `statement.timeline`.
- **`(operator)/customers/[id].tsx`** — "Record payment" row above the existing "Record advance
  payment", pushing `/(operator)/payments/record` with `{ customerId, customerName }`.
- **`(operator)/payments/record.tsx`** — seeds its customer state from those optional params so
  the picker step is skipped when the caller already knows the customer; no params = picker as
  before, and "Change" clears back to it either way.

### PR-F 2026-08-20 — supplier-statement capture (capture + read only, by design)

- **`(operator)/statements/index.tsx` (new)** — capture-and-read only. Mobile can photograph or
  pick a supplier statement and read a scan's status/summary; it deliberately **does NOT host the
  reconciliation grid** — a dense statement↔bill table earns a desktop, and the plan's design
  stance is explicit. After a capture it shows "ready to review on the web dashboard" with the
  parsed summary. Local steps `ListStep` / `ScanningStep` / `ResultStep` / `ErrorStep`;
  `describeStatementScanError` gives each of the four AI codes its own copy, offering a retry only
  for `AI_UNAVAILABLE`.
- **`lib/api/supplier-statements.ts` (new)** — `useSupplierStatements(params)`,
  `useScanStatement()` (multipart, **field name `files`**, not the invoice scanner's `images`),
  `getStatementAiError()` + `SupplierStatementScanSummary`/`StatementAiErrorCode` types mirroring
  web's module. `toScanSummary` flattens the raw scan row for the list.
- The API module is registered in `app.module.ts`, so these calls are live. See api.md →
  `supplier-statements/`. No pure-logic module was added (nothing here needs one), so there is no
  new `__tests__/` entry.
- **Entry point:** a fourth `QuickLink` ("Statements", `reader-outline`) in the quick-links row of
  `(operator)/(tabs)/finance.tsx`, alongside All bills / Expenses / Suppliers. Without it the
  screen is unreachable (file-based routing needs no `Stack.Screen` registration).

### Developer mode gate 2026-08-20 — dispatch/driver/route hidden behind an addon

The dispatch/driver/route feature set isn't customer-ready, so it is hidden on every tenant
EXCEPT ones carrying the hidden legacy `TenantAddon.addonKey` `developer_mode`
(`DEVELOPER_MODE_ADDON` in `@routeflow/types`, toggled from the platform-admin tenant page).
**Superseded 2026-08-28** — see "2026-08-28 — developer_mode narrowed + dispatch API enforced"
below: the hiding is no longer UI-only (the dispatch API now 403s via `@RequireAddon`), and
`developer_mode` no longer unlocks the two GA delivery features. `app/(driver)/**` has **zero
diff**. **Launch reversal = grep `useDeveloperMode`** and delete the conditions.

- **`lib/api/addons.ts` (new)** — `useDeveloperMode()` → `{enabled, isLoading, resolved}`. Mirrors
  `lib/api/tobacco.ts`'s `useTenantAddons` fetch (`GET /tenants/me/addons`, query key
  `["tenant", tenantSlug, "addons"]` so the cache is shared, staleTime 5min) with three deliberate
  differences:
  `enabled: isAuthenticated` (`useAuthStore`) because pre-auth screens mount before a token exists;
  `isLoading = isAuthenticated && query.isPending && query.failureCount === 0` — **with a disabled
  query TanStack v5 `isPending` stays true forever**, so a bare `isPending` would report a
  logged-out screen as loading and hold the bootstrap spinner up; and `retry: 2` instead of
  tobacco's `retry: false`, since this read is load-bearing (only the first attempt reports
  loading, so retries heal the flag behind the UI).
- **Addons query key is tenant-scoped** — `["tenant", tenantSlug, "addons"]` (slug from
  `useTenantStore`), in BOTH `lib/api/addons.ts` and `lib/api/tobacco.ts` so they still share one
  cache entry. The QueryClient is module-scoped in `app/_layout.tsx` and nothing clears it on
  logout (`useAuthStore.logout` wipes zustand state + tokens only), so a tenant-agnostic key let a
  `developer_mode=true` result survive a sign-out and unhide the whole dispatch surface for the
  NEXT tenant signed in on the same device within the 5-min staleTime.
- **`resolved` vs `enabled` — the stranding rule.** A failed fetch leaves `enabled` false, which is
  fine for hide-only gates but catastrophic for routing: treating "unknown" as "not a dev tenant"
  parks a dev-mode tenant's pure DRIVER on `operator-blocked`, whose only control is Sign Out and
  which has no refetch to rescue them. Anything that can strand a user keys off `resolved` and
  **fails OPEN**.
- **`app/_layout.tsx` `RootLayoutNav`** — the driver branch of the role-routing effect returns
  early while `devLoading`, and on `devResolved && !devMode` sends a pure `user.role === "DRIVER"`
  to `/(auth)/operator-blocked` (guarded on `segments` like the SUPER_ADMIN/CUSTOMER blocks so it
  can't re-replace itself) while a dual-role user just `setActiveRole("operator")` and re-enters
  the effect. `bootstrapping` gained `|| (!!user && activeRole === "driver" && devLoading)` so the
  existing spinner covers the in-flight query — no driver-UI or operator-blocked flash.
- **`app/(operator)/_layout.tsx`** — ONE deep-link chokepoint instead of ~15 screen guards:
  `DEV_MODE_SECTIONS = {dispatch, routes, route-runs, drivers, driver, fleet}`, section derived as
  `segments[1] === "(tabs)" ? segments[2] : segments[1]` (tabs live one group deeper), and
  `<Redirect href="/(operator)/home" />` when `!devLoading && !devMode`. All hooks stay above the
  conditional return.
- **`lib/operator-tabs.ts` `visibleOperatorTabs(devMode)`** — pure, order-preserving, drops
  `"dispatch"`; both branches spec'd in `__tests__/operator-tabs.test.ts`. `OperatorTabBar` passes
  `devMode && !devLoading`, i.e. **default-hidden while loading** — a non-dev tenant must never see
  Dispatch flash then vanish; a dev tenant sees it a moment late on cold start only.
- **Screens:** `(operator)/(tabs)/home.tsx` derives an `effectiveViewMode` that is forced to
  `"operator"` whenever `devMode` is false (so `DriverInlineView` can never render), gates the
  operator/driver mode bar on `devMode && user?.canActAsDriver`, the "DISPATCH READINESS" hero and
  the "Routes today" section on `devMode`, and **swaps the Active-drivers KPI cell for Customers**
  rather than dropping it, so the hero keeps its cells-per-row. `(operator)/(tabs)/more.tsx` gates
  the Routes / Fleet / Drivers rows and ANDs `devMode` onto the existing `canActAsDriver` Drive-mode
  row. `(tenant)/_layout.tsx` gives the dispatch `Tabs.Screen` `href: devMode ? undefined : null`.
  `(auth)/role-picker.tsx` (no in-app entry point today — defense in depth) hides the Driver hero
  and auto-selects operator.

### 2026-08-24 — ad-hoc order trips + fulfillment mode (dev-mode-gated)

- **`DEV_MODE_SECTIONS`** gained `trips`, **`SECTION_TO_TAB`** gained `trips: "dispatch"` (both —
  a section listed without a tab mapping leaves the deep-link chokepoint unable to route to a tab,
  a dead-tab-bar failure mode). `(operator)/(tabs)/dispatch.tsx` gets a Trips row (parallel to the
  existing Routes/Fleet/Drivers rows), gated the same `devMode` way; nothing was added to
  `more.tsx`. `(operator)/trips/` (new) hosts the builder screens — same PICKING → Build → BUILT →
  Send state machine as web (mobile folds it into ONE CTA that runs create → optimize → createRun,
  but holds the created route in `createdTrip` state with its frozen stop groups + order ids, so a
  failed dispatch retries against the SAME route instead of orphaning a duplicate draft per press;
  swipe-to-drop and the origin gate switch off once it is set, and the free-text run date is gated
  on `/^\d{4}-\d{2}-\d{2}$/` client-side to match `CreateRouteRunDto.@IsDateString()`), all three
  `resolveOrigin` origin types (DRIVER/ADDRESS/TENANT). The
  Driver origin needs the picked driver's `homeLat`/`homeLng` (now on `admin.ts AdminDriver`), not
  just a picked driver — without them the tab warns "{name} has no home base set" and links to
  `drivers/[id]/edit`, matching web's `TripOriginPicker`. `(operator)/trips/index.tsx` lists ADHOC
  routes and shows its trash affordance **only on run-less drafts** (same rule as web's two trip
  lists, backed by the `deleteRoute` ADHOC guard — deleting a dispatched trip would destroy the
  run stops carrying POD/signature data).
- **`lib/trip-grouping.ts`** mirrors `packages/types/trip-grouping.ts` `groupOrdersForTrip`
  **byte-for-byte** (own Jest test `__tests__/trip-grouping.test.ts` — not re-exported from the
  shared package, this is the RN-side copy per the "mobile mirrors web" convention). `lib/trip-
draft.ts` mirrors web's `lib/trip-draft.ts` (local-only picked-orders draft, cleared only on
  dispatch success).
- **`lib/order-actions.ts`** (new) — `statusActions` **extracted** out of the order-detail screen
  to `statusActions(status, fulfillPath = "ROUTE")`: the ROUTE-path output is byte-identical to
  the pre-extraction inline logic (regression pin in `__tests__/order-actions.test.ts`); a
  `fulfillPath: "SHIP"` order gets carrier-facing relabels ("Mark shipped" etc, mirrors the api
  `orders.service.ts changeStatus` SHIP branch) and drops the "Partial delivery" action (shipped
  orders don't get a driver-side partial-delivery flow). `orders/[id].tsx` calls the extracted
  helper instead of inlining it; `NewOrderScreen.tsx` + `CustomerForm.tsx` gained the
  `fulfillPath` field wired through the same create-draft round-trip pattern as web's
  `CreateOrderModal`/`CustomerFormModal`. That round-trip needed the plumbing types to carry the
  field: `lib/drafts-payload.ts` `OrderDraftPayload.fulfillPath?` (optional on the wire — a draft
  parked before the field existed resumes as ROUTE) + `DraftBuilderState.fulfillPath` (required)
  through BOTH converters; `lib/api/customers.ts` `CustomerDetail.fulfillPath?` +
  `CreateCustomerDto.fulfillPath?` (the per-customer default the order form seeds from); and
  `lib/api/orders.ts` `CreateOrderAsDriverDto.fulfillPath?` (the submit payload — omitted on
  ROUTE so the server default carries). `NewOrderScreen` only lets a parked value win when the
  draft's customer matches the current one, so the "Change customer" remount still re-seeds from
  the new customer's default, matching web.
- Orders select-mode / bulk affordances stay hidden without dev mode, and **`orders` was
  deliberately NOT added to `DEV_MODE_SECTIONS`** (the base orders screen must stay visible to
  every tenant — only the trip-planning entry points are dev-gated, via the `dispatch.tsx` Trips
  row and the builder screens themselves).
- Findings + demo-seed coordinate fix for this feature: `docs/phase0-adhoc-trips-findings.md`.
