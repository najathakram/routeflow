# mobile — App shell & lib

> Split from `.claude/code-map/mobile.md` (verbatim, lines 87-204) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## App shell & lib

- root `app/_layout.tsx` — Gesture + SafeArea + QueryClient + fonts + Notifications + auth/tenant/buyer init gates + ConfirmModal. Its role-routing effect also owns the **driver developer-mode gate** (see "Developer mode gate 2026-08-20" below). Module-top `initSentry()` (`lib/sentry.ts`, 2026-08-26): web-platform-only, inert unless `EXPO_PUBLIC_SENTRY_DSN` set, dynamic-imports `@sentry/react`, fire-and-forget.
- **developer mode** `lib/api/addons.ts` — `useDeveloperMode()` → `{enabled, isLoading, resolved}`; since 2026-08-28 the gate for the still-in-development surfaces ONLY — the `(driver)` app, the role-picker driver option, the `(tenant)` dispatch tab, and operator drive-mode. Dispatch/route surfaces follow `useRoutesAccess()`/`useDeliveryAccess()` instead (see "Developer mode gate 2026-08-20" + the 2026-08-28 narrowing below).
- **`lib/calendar-date.ts`** (NEW, F25, 2026-09-04, B90/B91) — the shared calendar-date helper,
  mirroring `apps/api/src/common/calendar-date.ts` name-for-name: `calendarDateFromIso`,
  `isoFromCalendarDate`, `calendarDayBounds`, plus a re-export of `fmtCalendarDate` from
  `lib/format-date.ts`. `lib/run-lateness.ts` exports `isRunPastDue(scheduledDateIso, now, timeZone?)`
  — pure lateness check used by the operator Exceptions screen (`app/(operator)/exceptions.tsx`);
  "today" is derived in `timeZone` via Intl when supplied, device-local otherwise (replaces a
  `setHours(0,0,0,0)` comparison that read the wrong day west of UTC). `app/(operator)/customers/[id]/licenses.logic.ts`
  exports `buildExpiresAtIso(expiresAt)` — the licence-renewal writer now round-trips through
  `isoFromCalendarDate` instead of a local `new Date(day + "T23:59:59")` construction (the B91
  writer-half fix; see `scripts/repair-f25-licence-dates.mjs` for the one-time data repair).
  Tests: `__tests__/run-lateness.test.ts` (REG-B90), `__tests__/licence-expiry-iso.test.ts`
  (REG-B91 writer test, T5), `__tests__/calendar-date-bounds.test.ts` (calendarDayBounds T12
  mirror pin, twin of the api/web specs). `app/(customer)/payments.tsx` renders credit expiry
  with `fmtCalendarDate(c.expiresAt, "short")`. See L-047.
- **calendar dates** `lib/format-date.ts` (NEW 2026-08-23) — `fmtCalendarDate(iso, style?)` formats UTC components (`timeZone:"UTC"`): invoice/bill/order calendar dates are stored at UTC midnight and local `toLocaleDateString` showed the previous day for US viewers. Routed through it: operator+customer invoice list/detail, recurring-invoices list/detail, vendor-bills scan, sale-flow new.tsx. Rule: calendar fields only — real timestamps (`paidAt`, `createdAt`, any `@default(now())`) keep local rendering. ~20 more calendar-date sites (vendor-bill [id]/index/finance, credit-notes, POs, estimates, requestedDeliveryDate) are known and queued for the follow-up sweep PR.
- **API client** `lib/api-client.ts` — axios base, 15s timeout, `getActiveAccessToken()` respects role-namespaced keys (`rf:op:accessToken`, `rf:driver:accessToken`, ...).
- **auth / secure storage** `lib/auth.ts` — SecureStore native / localStorage web, token refresh with 401-retry.
- **tenant branding** `lib/tenant-store.ts` — slug, businessName, primaryColor, logoKey (persistent Zustand).
- **location tracker** `lib/location-tracker.ts` (+ `.web.ts`) — driver background location.
- **location payload seam** `lib/location-payload.ts` (NEW 2026-09-04, B185) —
  `buildLocationPayload(coords, recordedAt)` extracted out of `lib/location-tracker.native.ts`'s
  two inline POST-body call sites (behavior-preserving seam so it is unit-testable without
  Expo/TaskManager). iOS reports `-1` for heading/speed with no fix; this maps a
  negative-or-null `heading`/`speed` to `null` (was forwarded raw and 400'd on the API's
  `@Min(0)` decorators), converts a present speed m/s→km/h, and passes `accuracy` through only
  when present and `>= 0` (omitted otherwise, matching the API's new `@Min(0)` bound — no
  `@Max`). Both `location-tracker.native.ts` call sites spread its return alongside their
  existing lat/lng/runId fields. Spec: `__tests__/location-payload.test.ts`.
- **stores** `store/{cartStore,mileageStore,podStore,routeStore,productPickerStore,offlineQueue,listUiStore}.ts`.
- **scan/queue/toast primitives (NEW 2026-08-31, F30 — all pure + jest'd, see the F30 batch section):**
  `lib/scan-pending-buffer.ts` (`PendingBufferState`, `PENDING_BUFFER_DEPTH` = 2, `createPendingBuffer`,
  `pushScan`, `completeResolve` → `{next, startResolving}`) · `lib/wedge-submit.ts`
  (`createWedgeSubmitHandler(deps)`, `createAutoAddGuard()`, `createScanAttempt(guard?)`) ·
  `lib/queue-drain.ts` (`MAX_RETRIES`, `buildReplayRequestConfig`, `drainQueue`, `FailedActionRecord`,
  `DrainResult`, `describeQueuedAction` — endpoint+body → "New order (3 items)" —, `describeFailedDrain`
  → `{title, message}` for ONE aggregated alert per drain; ⚠️ `DrainDeps.notifyFailed` is **required,
  never optional** — the caller dequeues everything in `failedActions`, so a drain that cannot record
  them is REG-B143 verbatim, and while it was optional an omitted hook compiled clean and no-op'd
  silently; ⚠️ **PR-2 (imp-02, 2026-09-03):** a 409 `{code:"MERGE_IN_PROGRESS"}` or a 503
  `{code:"LOCK_UNAVAILABLE"}` (order-merge advisory-lock contention, `apps/api/src/common/db-locks.ts`)
  is RETRIABLE — same path as a 5xx/network failure, not the non-retriable 4xx path — via
  `isRetriableLockContention`) · `lib/toast-host.ts` (`registerToastHost`/`releaseToastHost`/`getToastHost` — the
  iOS sink `lib/toast.ts` reaches, registered by `useInlineToast` itself) · `lib/order-submit-key.ts`
  (`getOrderSubmitKey()` mints one uuid per cart session, `resetOrderSubmitKey()` on a landed submit).
- **List-state restore (PR-6 WP1, 2026-08-18):** `lib/list-ui-snapshot.ts` (pure) — `ListUiSnapshot{search,filters,scrollOffset,pageCount,savedAt}`, `isSnapshotFresh` (15min TTL), `snapshotHasSearchOrFilter` (skip the page-chase when true — that result set is already short), `shouldContinuePageChase` (bounded by BOTH `MAX_RESTORE_PAGES=10` and `MAX_RESTORE_ROWS=150`), one-shot `queueScrollRestore`/`stepScrollRestore` (refuses to fire twice; re-armed via `useFocusEffect` for the `display:none` tab case). `store/listUiStore.ts`: in-memory (non-persisted) Zustand keyed by list id — `OPERATOR_PRODUCTS_LIST_ID="operator-products"`, `getListUiSnapshot<TFilters>()` typed reader. Wired into `products/index.tsx`: lazy-init search/filters from the snapshot on mount, write-through save on every change + on scroll (`onScroll`, ignored while blurred). Scroll restore: the next focus's offset is captured on BLUR (`restoreOffsetRef`), not from the frozen mount snapshot — on web the stack hides this screen with `display:none` (never unmounts) and the browser zeroes the hidden scroller. Each focus resets `restoreAbandonedRef` and re-arms; `applyPendingRestore` runs from `onContentSizeChange` AND a `restoreState` effect (the visibility flip changes no content size) and refuses to spend the one-shot until `chaseDone && products.length > 0` (`chaseDone` is true before the first page lands). ⚠️ **RNW never fires `onScrollBeginDrag`** (`ScrollViewBase` wires only `onScroll`), so a user scroll is detected in `handleScroll` — any offset that is neither 0 (layout/visibility resets) nor `restoreTargetRef` (the restore's own echo); `onScrollBeginDrag` stays wired for native. Also adopted here: 250ms debounce (`PRODUCT_SEARCH_DEBOUNCE_MS` reused from `lib/use-product-search.ts`), `flattenPages` from `lib/paged-rows.ts`, `onEndReached` gated on `!isPlaceholderData` — backed by `placeholderData: keepPreviousData` on `useAdminProductsInfinite` (`lib/api/admin.ts`), so mid-search the previous rows stay on screen and can't be paged. Spec: `__tests__/list-ui-snapshot.test.ts`.
- **order-entry / catalog batch (2026-07-11):** `components/ProductPickerSheet.tsx` (server search + camera scan + `standaloneOnly` variant-parent mode; used by Quick Receive, ProductForm variant picker, vendor-bill link; **2026-09-14:** lazy-gated via `useAdminProductSearch` instead of a `limit:0` fetch-all — see `mobile/tests-2.md`'s "2026-09-14" §Lane E), `components/InlineCreateProductSheet.tsx` (create-on-scan-miss overlay — new-product OR variant-of, preserves the cart; `initialCode/initialName/initialPrice/initialCost`), `lib/product-form.ts` (pure `buildProductPayload`/`emptyProductForm`/`productFormFromValues` — variant-aware, re-exported by `components/ProductForm.tsx`, tested in `operator-create-forms.test.ts`), `lib/product-display.ts` (`displayProductName`/`PRODUCT_NAME_SEPARATOR` mirror of web), `lib/money-input.ts` + `components/MoneyTextInput.tsx` (no-reformat money field), `lib/vendor-bill-scan.ts` `unmatchedCount`/`linkScanItem`, `formatQtySplit` in `lib/pricing.ts`. `lib/api/products.ts` `useCreateProduct` returns `CreatedProduct`; `CreateProductDto`+={parentProductId,variantName}.
- **Scan-to-order split view + declutter (2026-08-07):** the client complaint ("I scan an item, it's
  added, but I never SEE it") was architectural, not a scroll bug — during continuous scanning
  `BarcodeScanner` is a full-screen `absoluteFill` camera at `zIndex 2000` covering the list, so
  nothing underneath it could ever be visible, and the hand-rolled scroll machinery
  (`scrollRef`/`listTopRef`/`rowYRef`/`scrollToId` + per-row `onLayout`) went stale anyway because
  clearing the search swapped the rendered list out from under the cached row Y. **New shared parts:**
  `lib/scan-tray.ts` (`bumpScanOrder` — front-inserts, reference-stable when already first;
  `trayRowsFrom` — newest-first rows whose subtotals go through the SAME `computeLineSubtotal` the
  footer uses, so tray and footer cannot disagree; optional `overridable(product)` ignores line
  `unitPrice` overrides on SPECIAL-tier lines, mirroring the footer/submit; `nextFlash` — `{id,
nonce}` so a re-scan re-flashes; **2026-09-14:** optional `freeUnitsFor(id,line)` nets a
  BUY_N_GET_M line the same way the footer does — see `mobile/tests-2.md`'s "2026-09-14" §Lane B),
  `lib/pending-scroll.ts` (`requestScroll`/`stepPendingScroll` — re-resolves the target index against
  the ids rendered THIS pass, so it survives the refetch window that broke the cached-offset version),
  `lib/haptics.ts` (`scanHaptic`, first expo-haptics use in the app), `components/ScanCamera(.web).tsx`
  (layout-agnostic camera engine extracted from `BarcodeScanner(.web)`, which are now thin wrappers —
  their six other call sites are unchanged), `components/ScanTray.tsx` (newest-first FlatList, NOT
  `inverted`, `forwardRef` → `scrollToTop`), `components/ScanOrderSheet.tsx` (camera ~45% / live order
  tray ~55%), `components/ProductRow.tsx` (memoized catalog row), `components/InlineToast.tsx` (needed
  because `lib/toast.ts` is a NO-OP on iOS, so those users had NO feedback for draft-saved / credit-
  created / line-removed). **`NewOrderScreen.tsx`** and **`(operator)/(tabs)/invoices/new.tsx`** (a
  structural copy that carried the same duplicated machinery) both migrated: `filtered.map` inside a
  ScrollView → FlatList (`extraData={items}`, no `getItemLayout` since added boxed rows vary in height,
  `onScrollToIndexFailed` = offset estimate + one rAF retry); `BarcodeFab` removed from these two
  screens (it mounted a SECOND scanner instance) leaving the SearchBar barcode icon as the single
  entry point; in scan mode a hit does `addOne` + bump + flash + haptic and deliberately does NOT
  `setSearch("")` and shows NO success banner (the tray row IS the confirmation), while outside it the
  old clear-search + scroll + banner behaviour is kept. Declutter: Order options and Apply credit moved
  into CartModal as collapsed sections (state stays lifted — the submitted payload is unchanged), the
  standalone "+ Add unlisted item" band deleted (homes: cart action + empty-search state), NavBar Save
  removed (three save triggers → one footer Confirm; Save-as-draft stays), the boxed in-row editor cut
  from ~9 controls to stepper + summary + an Edit affordance into CartModal's full per-line editor, and
  the never-populated 48×48 image placeholder dropped. The relocated Order-options section also hosts
  the staff-only **"Order date (backdate)"** field. **Two escape hatches the declutter had closed** are
  re-opened by pure predicates so they can be tested: `lib/unlisted-affordance.ts`
  `unlistedAffordancePlacement({rowCount, loading})` → `"list-footer" | "empty-state" | "none"` drives
  BOTH the catalog FlatList's `ListFooterComponent` and its `ListEmptyComponent` from one call, so
  exactly one opener is ever live — without it, "Add unlisted item" survived only in the empty-state
  and inside CartModal, and every footer opener of CartModal is gated on `totalItems > 0`, leaving a
  non-empty catalog + empty cart with NO way to add an off-catalog item (the exact case that starts an
  order). `lib/scan-fallback.ts` `scanFallbackContent({hint, manualMode, hasError})` keeps the help copy
  behind `hint` but computes the manual-entry link from `manualMode` only: `ScanOrderSheet` passes
  `hint={false}`, and `ScanCamera.web`'s old `showCard` gate meant a camera that OPENS but cannot decode
  (bad light, damaged barcode, soft-focus webcam) offered no way in — `manualMode` only flips when
  getUserMedia or the zxing import outright fails. Tests:
  `__tests__/{scan-tray,pending-scroll,unlisted-affordance,scan-fallback}.test.ts` (the scan-fallback
  suite sweeps all 8 hint × manualMode × hasError states asserting a manual input or link in each).
- **Vendor-bill duplicate handling (2026-08-07):** `lib/vendor-bill-scan.ts` `buildBillDtoFromScan` had
  been DROPPING the scanned invoice number entirely (so mobile-created bills were invisible to dedup) —
  it now emits `supplierInvoiceNumber` and folds a "Supplier invoice #N" fragment into `notes` so the
  server's legacy parser still matches. `(operator)/vendor-bills/scan.tsx` pre-flights
  `check-duplicate` before saving (a failed probe proceeds — the server guard is the backstop) and
  routes a match into a 3-way prompt: Open existing bill / Create anyway (`allowDuplicate`) / Cancel;
  the same 409 is re-parsed in the create mutation's `onError` to cover the race.
- **Scan archive wiring (2026-08-09):** `lib/api/vendor-bills.ts` `ScanResult` += `scanId` /
  `priorScan` (`PriorScanSummary`, mirrors web) — set only when the uploaded BYTES hash to a scan
  already on file, in which case the payload is the STORED extraction replayed with no second AI
  call. `lib/vendor-bill-scan.ts` `buildBillDtoFromScan` stopped discarding what the OCR read:
  `scanId`, `subtotal`, `taxAmount`, and per-line `sku`/`packSize`/`lineTotal`, all as PRINTED.
  **`taxAmount` moves money** — the server adds it on top of the line sum, so `scanBillTotal` counts
  it too or the duplicate probe stops matching the create-time guard (mobile previously sent no tax
  at all, unlike web). New pure `priorScanPrompt(prior)` → `{title, message, billId, billLabel}`:
  POSTED-with-a-bill reads "You already scanned this" and offers the bill; anything else reads
  "Picking up where you left off" with nothing to open. `(operator)/vendor-bills/scan.tsx` fires it
  through `chooseAction` on scan success AND keeps a standing `PriorScanBanner` in ReviewStep
  (orange wash w/ bill link, green wash when merely restored).
- **Build/typecheck hermetics (2026-08-28, npm-ci migration):** `tsconfig.json` pins `typeRoots` to `./node_modules/@types` + `../../node_modules/@types` — without it tsc walks EVERY ancestor `node_modules/@types`, and from a git worktree that reaches the MAIN checkout's install (silent drift; broke when a concurrent session touched it). `package.json` declares `expo-modules-core 55.0.25` EXACT — must track `expo`'s own exact pin (bump both together): root expo-* packages (expo-notifications et al) import it without declaring it, and without the explicit dep npm nests the only copy under `node_modules/expo/node_modules/`, unreachable by walk-up → skipLibCheck-silenced import failure → phantom TS2339s on expo types. `jest ^30.2.0` must stay range-compatible with the root override pin (`jest 30.2.0`) or npm 10's override-unaware `npm ci` validator explodes (see code-map CHANGELOG 2026-08-28 night). `react-test-renderer 19.2.0` is EXACT for the same reason and must track this workspace's `react` pin (and `jest-expo`'s own exact pin): it is declared nowhere else and enters only as a floating peer of `@testing-library/react-native` (`>=18.2.0`, non-optional), so before the pin a from-scratch resolution ERESOLVE'd on 19.2.8 wanting `react@^19.2.8`. (The now-removed `@testing-library/jest-native` had the same floating peer at `>=16.0.0`.) Pinned in `apps/mobile` rather than root `overrides` because the lock records NO `overrides` field, which makes an override invisible to `npm ci`'s own validator. ⚠️ Dropping `@testing-library/jest-native` (done) did NOT make the pin redundant — `react-native` declares its OWN non-optional `react-test-renderer >=18.2.0` peer (only `jest` is optional in its `peerDependenciesMeta`); measured, from-scratch ERESOLVEs with jest-native AND the pin both removed. Do not remove the pin.
- **Operator invoice print (2026-09-15, WP3):** `lib/print-logic.ts` (NEW, node-safe, no RN
  imports) — `classifyPrintError(err)` → `"dismissed" | "failed"` (an expo-print
  `..._PRINT_INCOMPLETE` code or a "did not complete" message is a user dismissal, not a
  failure — mirrors `lib/share-error.ts`'s `classifyShareError`), `printTransport(os)` →
  `"tab" | "native"` (web routes through the existing `openPdfInTab`, never `expo-print`, R6.5).
  `lib/print-pdf.ts` (NEW) — `printPdf({url, filename})`: web calls `openPdfInTab` (`lib/share-pdf.ts`)
  directly; native lazily `import("expo-print")` (R6.4 — never a top-level import, so a build
  without the native module linked doesn't crash just from importing this file), downloads the
  PDF via `expo-file-system/legacy` `downloadAsync` into the cache dir (same legacy entry point as
  `share-pdf.ts`, B203), then `Print.printAsync({uri})`. `package.json` gained `expo-print ~55.0.19`
  via `npx expo install expo-print` (SDK-55-line pinned, matching `expo`'s own major — see
  `expo-print-pin.test.ts`). Wired into `app/(operator)/(tabs)/invoices/[id].tsx`: a Print tile
  after the Share tile, its own `printPdfMut = useInvoicePdf()` + `printing` state, "Preparing
  PDF…" label + `disabled={printing}` while pending, `try/finally setPrinting(false)` around the
  `printPdf` call (mirrors `handlePdf`, same file). Tests: `__tests__/print-logic.test.ts`,
  `__tests__/expo-print-pin.test.ts`, `__tests__/invoice-print-tile.pins.test.ts` (source-text pin,
  same convention as `session-teardown.pins.test.ts` — the RN component isn't rendered under the
  mobile Jest env).
- **`shareCsv` download-status guard (2026-09-15, sibling of PR #756 review finding F2):**
  `lib/share-pdf.ts` `shareCsv()`'s native branch now destructures `status` from
  `FileSystem.downloadAsync(url, target)` and throws before `Sharing.shareAsync` when
  `!isDownloadOk(status)` (`lib/print-logic.ts`) — `downloadAsync` resolves, never rejects, on a
  non-2xx response, so an unguarded call saves/shares an error page as the real file.
  `sharePdfNative` (same file) already had this guard from #756's F2 follow-up; `shareCsv` was the
  missed sibling. Both callers (`RegulatedFilingsList.tsx`, `(operator)/compliance/[id].tsx`)
  already try/catch `shareCsv()`. Test: `__tests__/pdf-download-status-guard.pins.test.ts` gained a
  third pin for `shareCsv`'s native branch (source-text pin, same convention as the print guard).
- **Buyer per-line notes render (2026-09-15, WP2, R5.6/R5.7):** `lib/api/buyer.ts` — `BuyerOrder.lineItems[]` and `BuyerInvoiceItem` each gained `notes?: string | null` (buyer-visible operator note, e.g. flavor). Rendered in `(customer)/invoices/[id].tsx` `LineItemRow` and `(customer)/orders/[id].tsx` order-detail list, both guarded `item.notes?.trim()`, new `styles.itemNote` (12px, `label2`) under the existing `itemMeta` line. Tests: `__tests__/buyer-line-note.pins.test.ts` (source-text pin, same convention as the WP3 print tests).
- **`lib/plan-flags.ts` (new, Lite-L2 WP11, 2026-09-15)** — `PLAN_GATED_SECTIONS: Record<string,
FlagKey>` maps operator route-group segments (`estimates`, `recurring-invoices`,
  `credit-notes`, `returns`, `suppliers`, `vendor-bills`, `analytics`, `reports`, `messages`) to
  the `FlagKey` (`@routeflow/types`) each needs; `expenses`/`finance`/`purchase-orders`/
  `statements` are NOT gated. Mirrors web's `lib/plan-gated-nav.ts` adapted to expo-router
  segments. `planLockedSection(segments, {flags,resolved,failed})` — the first path component
  after `"(operator)"` that isn't itself a route group; unknown/unresolved/failed all fail OPEN
  (only a positively resolved-and-denied flag locks). `planFlagVisible(s)` — same three-valued
  rule as web (resolved ⇒ by the flag; unresolved ⇒ hidden; failed ⇒ shown). **Fix-round finding
  5 (2026-09-15):** `flags` param is `readonly string[] | undefined` — `undefined` (the response
  resolved but the `flags` key was absent) also fails OPEN, same as unresolved/failed; only an
  actual array (including `[]`) is checked with `.includes()`.
- **`lib/api/billing.ts` (new, WP11)** — `useSubscription()`: tenant-scoped query key
  (`["tenant", tenantSlug, "subscription"]` — mirrors `lib/api/addons.ts`'s `useDeveloperMode`
  pattern so switching tenants on one device never hands the next session a stale answer),
  `enabled: isAuthenticated`, `retry: 2` (load-bearing for section-locking, not `retry:false`).
  `usePlanFlag(key: FlagKey)` → `{enabled, resolved, failed}` — `resolved` says the flag was
  actually READ; `planLockedSection` and any other stranding caller must key off it, never a
  bare `!enabled`. **Fix-round finding 5 (2026-09-15):** `enabled` is `true` when
  `q.data?.flags` is `undefined` (fail open), `.includes(key)` once `flags` is an actual array.
- **`components/PlanLockedScreen.tsx` (new, WP11)** — rendered in place of a gated operator
  route-group's `<Stack>`; structural clone of `app/(auth)/operator-blocked.tsx` (SafeAreaView →
  centered column, 64px Ionicons lock icon, title, message, one `MobileButton`, same color
  literals — no new tokens). `onBack` defaults to `router.back()` (billing is web-only, so there
  is no "See plans" equivalent here).
- **`app/(operator)/_layout.tsx` — plan-gated section lock (WP12/R4.4/R4.6):** a `useSubscription()`
  call feeds `planLockedSection(segments, {...})`; when it denies, renders `<PlanLockedScreen
planName={sub.data?.planName ?? "current"} />` in place of the section's own stack — a
  render, not a redirect (URL/back-stack stays intact), mirroring web's `RouteGuard`.
- **`app/(operator)/(tabs)/more.tsx` — plan-flag-gated row visibility (WP12/R4.4):** Recurring
  Invoices/Estimates/Credit Notes/Returns/Analytics/Reports/Messages rows each wrapped in
  `planFlagVisible(usePlanFlag("flag.<key>"))` (seven `usePlanFlag` calls) instead of always
  rendering; unchanged rows (Payments, Shipments, Purchase Orders, etc.) are not gated.
- **mobile↔web parity waves (2026-07-11, #225):** ~14 waves of mobile-only fixes bringing mobile to web parity across scan UX, money flows, compliance, invoicing, returns, and the buyer portal — see the dedicated "Where to find" rows above (Returns, Continuous barcode scan, Always-visible scanned cart rows, Incremental order-item edit, Regulated-license guard, Buyer favorites/finances/licenses, Buyer cart promotions, Scan-driven stock count, Product cost-basis tools + photos, Post-delivery invoice send, Invoice write-off/payment edit, Save order as draft/reopen/recurring create, Live margin hint). Also: `store/cartStore.ts` `CartItem` gained `category` (so CATEGORY-scoped buyer promos can match a cart line); `package.json` added `expo-image-manipulator ~55.0.16` (JPEG transcode for product-photo upload — needs a native rebuild on deploy); `lib/api/admin.ts` `AdminOrder.customer` widened with `mobile`/`email` (feeds the send-invoice sheet) + new `useAdminProductsInfinite` (pages the whole catalog, was a single `limit:100` call that silently dropped rows past 100 — same fix on the buyer side via `useBuyerProductsInfinite` in `lib/api/buyer.ts`). Two waves described in the PR's commit messages (ProductForm "Variant of" create-link UI, product-detail "Variant(s)" card) did **not** land in the final reconciled merge — verified absent from `ProductForm.tsx`/`products/[id].tsx`; only the photo-upload half of that wave (12) is present.
