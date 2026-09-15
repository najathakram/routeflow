# mobile — Tests (part 2 of 2)

> Split from `.claude/code-map/mobile.md` (verbatim, lines 933-1562) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

### 2026-08-25 — recurring-routes / order-delivery addon split

`developer_mode` is no longer the only gate for the dispatch/route/driver/trips surface — it
splits into two independent per-tenant addons (which, as of 2026-08-28, it no longer unlocks).

- **`lib/api/addons.ts`** gains `useRecurringRoutes()`/`useOrderDelivery()` (`RECURRING_ROUTES_ADDON`/
  `ORDER_DELIVERY_ADDON` from `@routeflow/types`, same `useQuery` shape/cache-key as
  `useDeveloperMode`/`useDriverPayments`) and the composition helpers
  **`useRoutesAccess()`/`useDeliveryAccess()`** (`{enabled, resolved}`). Every gate below reads
  the composed hook, never the raw addon hook. **2026-08-28:** each helper now returns its
  feature hook UNCHANGED — the `devMode ||` disjunct is gone (return shape identical).
- **`app/(operator)/_layout.tsx`** chokepoint: `DEV_MODE_SECTIONS` replaced by
  `sectionNeed(sec, screen) → "routes" | "delivery" | "either" | null` over three sets —
  `ROUTES_SECTIONS = {routes, fleet}`, `DELIVERY_SECTIONS = {trips}`,
  `EITHER_SECTIONS = {dispatch, drivers, driver, route-runs}` (the shared hub, driver records and
  run details serve both features). `routes` splits on its child screen:
  `RECURRING_ROUTES_SCREENS = {"", new, create}` stay routes-only, every deeper `routes/:id…`
  detail is EITHER — mirrors web's `RECURRING_ROUTES_PATHS`, because an ad-hoc delivery has no
  detail screen of its own (`trips/index.tsx` opens rows at `routes/:id`, `trips/new.tsx` replaces
  to `route-runs/:id` after dispatch). Redirect fires when the need's matching access is
  `resolved && !enabled` (routes → `routesAccess`, delivery → `deliveryAccess`, either → OR of
  both; resolved OR'd defensively across both hooks since they share one underlying query).
- **`(operator)/(tabs)/dispatch.tsx`** now surfaces the Routes/Fleet/Drivers rows under
  `routesAccess` and the "Order delivery" row under `deliveryAccess` independently, instead of one
  `devMode` gate for the whole screen — a delivery-only tenant sees Order delivery + Drivers with
  Routes/Fleet hidden. The Routes/Drivers `SegmentedControl` and BOTH of its tab bodies render only
  when `routesEnabled`; without it there is nothing to select `DriversTab` with, so the
  delivery-only case gets an explicit "Drivers → Manage drivers" row → `/(operator)/drivers`
  instead of an unlabelled full drivers list. Its three list queries (`useAdminRoutes`,
  `useAdminDrivers`, `useOperatorRouteRuns`) are `{ enabled: routesEnabled }` — the hub is now
  reachable by delivery-only tenants that render none of that data, so the fetches would otherwise
  be three wasted round-trips per visit. All three hooks gained the house
  `options?: { enabled?: boolean }` second param (`lib/api/{admin,routes}.ts`; default `true`, every
  other caller unchanged).
- **`(operator)/(tabs)/orders/index.tsx`** Select/bulk "Plan delivery trip" affordance now reads
  `useDeliveryAccess()` (was `useDeveloperMode()`).
- **`(operator)/trips/index.tsx` + `new.tsx`** (screen titles relabeled "Deliveries"/"Plan
  delivery") gate on `useDeliveryAccess()`.
- **`components/OperatorTabBar.tsx`** passes `routesAccess.enabled || deliveryAccess.enabled` to
  `visibleOperatorTabs` (param renamed `devMode` → `dispatchAccess`; pure filter unchanged). The
  Dispatch TAB must be as wide as `_layout.tsx`'s `EITHER_SECTIONS` — leaving it on
  `useDeveloperMode()` hid the bar entry from a tenant holding only `recurring_routes` or only
  `order_delivery`, so the widened sections had no way in. Still default-hidden while the addons
  query is in flight (both helpers report `enabled: false` until it resolves).
- **`(tabs)/more.tsx`** MANAGE rows now mirror `_layout.tsx`'s section sets: Routes + Fleet on
  `routesAccess.enabled`, Drivers on `routesAccess.enabled || deliveryAccess.enabled` (drivers is
  an EITHER surface — both features need it). **`(tabs)/home.tsx`** likewise gates the "DISPATCH
  READINESS" hero and the "Routes today" section on `routesAccess.enabled` (both read
  `useAdminRoutes`, which keeps the SCHEDULED/recurring default; the hero's Fleet button is
  routes-only, so widening it would be a dead end) and the Active-drivers↔Customers KPI swap on
  the EITHER access.
- **Drive mode keeps the RAW `useDeveloperMode()`** in BOTH files (`home.tsx`'s
  `effectiveViewMode` + mode bar, `more.tsx`'s Drive-mode row): the `(driver)` app is still
  `developer_mode`-gated in `app/_layout.tsx:178`, so widening those would hand an addon-only
  operator a button that bounces straight back. Both screens therefore hold `useDeveloperMode()`
  AND the two access helpers — one shared addons query, no extra fetch.
- `app/(driver)/**` stays untouched (`git diff --stat` shows nothing there).

### 2026-08-28 — `developer_mode` narrowed + dispatch API enforced

Owner decision: `developer_mode` stops being a master switch over the two GA delivery features
and keeps only the genuinely in-development surfaces. Mirrors web exactly (see [web](web.md)).

- **`lib/api/addons.ts`** — `useDeliveryAccess()`/`useRoutesAccess()` drop the `useDeveloperMode()`
  composition and return `{enabled, resolved}` off `useOrderDelivery()`/`useRecurringRoutes()`
  alone. Return SHAPE is unchanged, so every call site is untouched. `useDeveloperMode` stays
  exported — it still gates the in-dev surfaces below.
- **Untouched by design** (these ARE the in-development surfaces `developer_mode` still unlocks):
  `app/_layout.tsx` (driver-branch gate), `app/(auth)/role-picker.tsx` (driver option),
  `app/(tenant)/_layout.tsx` (dispatch `Tabs.Screen` `href`), and the RAW `useDeveloperMode()`
  drive-mode reads in `(tabs)/home.tsx` (`effectiveViewMode` + mode bar) and `(tabs)/more.tsx`
  (Drive-mode row) — the `(driver)` app they lead into is still dev-gated.
- **`(tabs)/home.tsx` query gating (the one behavior change beyond comments):** the dispatch API
  now 403s without an addon, so `useAdminRoutes` takes `enabled: routesAccess.enabled`,
  `useAdminDrivers` takes the EITHER gate, and both `useOperatorRouteRuns` calls take the EITHER
  gate (an ad-hoc delivery materializes a route + run). A tenant with neither addon polls nothing.
- Comment-only updates in `(tabs)/{home,more,dispatch}.tsx`, `(operator)/_layout.tsx`,
  `components/OperatorTabBar.tsx`, `lib/operator-tabs.ts` — the stale "each helper folds in
  developer_mode, so a dev tenant regresses zero" notes are now wrong and were rewritten.

### PR-D 2026-08-23 — sales-agent read parity (one row, read-only by design)

Web got the whole agents/commissions UI; mobile gets the cheapest honest mirror — **who holds
this customer** — and nothing else. Management stays on web, matching the supplier-statement
precedent (capture/read on mobile, review on web). No mobile write surface for agents exists.

- **`lib/api/tobacco.ts`** — `SALES_AGENTS_ADDON = "sales_agents"` beside `TOBACCO_ADDON`, read
  through the same `useHasAddon`/`useTenantAddons` pair (`GET /tenants/me/addons`, shared cache).
  Mirrors web's constant in `lib/api/addons.ts`.
- **`lib/api/customers.ts`** — `CustomerCurrentAgent` type + `useCustomerCurrentAgent(customerId,
enabled)` against the PR-D read endpoint `GET /sales-agents/assignments/current?customerId=`
  (key `["sales-agents","current-assignment",customerId]`, `staleTime` 2min). **The `enabled`
  argument is mandatory, not optional:** the route is plan-flag gated and 403s for every tenant
  without the addon, so an ungated fetch would fire on each customer screen open.
- **`app/(operator)/customers/[id].tsx`** — one read-only `Row label="Sales agent"` directly after
  the "Pricing tier" row, rendered only when `hasSalesAgents && currentAgent?.assignment`.
  **Absence is the empty state** — unflagged or unassigned shows no row at all, no placeholder.

### 2026-08-25 — customer-feedback batch (address CRUD, dead reopen, shipment gating)

- **`app/(operator)/customers/[id]/addresses.tsx`** — full CRUD: edit (all fields incl. label/
  `addressType`), delete, and set-primary, mirroring web's `customers/[id]/page.tsx` Addresses
  tab. `lib/api/customers.ts` gained `useDeleteCustomerAddress({customerId, addressId})` →
  `DELETE :id/addresses/:addrId` (invalidates `["customers", customerId]` on success; surfaces the
  server's 409 reason when a route stop still references the address). `CustomerAddressDto` gained
  `label` (required by the server's `CreateAddressDto` — empty string is valid) and `addressType`
  (update route validates against `["BILLING","SHIPPING","DELIVERY"]`); `CustomerDetail.addresses[]`
  gained matching `label?`/`addressType?` read fields.
- **BUG-ORD-01 was already fixed on mobile** (`order-actions.ts` never rendered a DELIVERED
  reopen affordance) — this batch only brought web into parity; no mobile change here.
- **Shipment gating** — `orders/[id].tsx`: `ShipmentSection` renders only when
  `order.fulfillPath === "SHIP"` or the order already carries `shippingCarrier`/
  `shippingTrackingNumber`. `invoices/[id].tsx`: same section, but gated on tracking data being
  PRESENT rather than `fulfillPath` — the invoice payload's `order` field (`admin.ts`
  `AdminInvoice.order`) is status/orderNumber only and was deliberately not widened just for this
  gate, so the check is
  `!isVoid && (!invoice.orderId || invoice.shippingCarrier || invoice.shippingTrackingNumber)` —
  order-linked invoices inherit tracking from the order (`orders.service.updateShipment` mirrors it
  down), while a standalone invoice has no order to record it on and keeps the section. Mirrors
  web's `invoices/[id]/page.tsx` gate.

### 2026-08-25 — sale-integrity phase 2 WP6: mirror reopen/demote/delete (⚠️ server not caught up)

- **`lib/order-status-flow.ts`** — `ORDER_STATUS_TRANSITIONS` gained `PENDING: [...,"DRAFT"]` and
  `DELIVERED: ["CONFIRMED","PARTIALLY_DELIVERED"]` (was `[]` — DELIVERED was deliberately terminal);
  `demotionRequiresReason` gained the matching `PENDING→DRAFT` and `DELIVERED→(CONFIRMED|
PARTIALLY_DELIVERED)` cases (staff-only, same set as the pre-existing demotions). `canDeleteOrder`
  now always returns `true` (was `DRAFT|PENDING|CANCELLED` only) — delete-any is now a server-side
  rule keyed on invoice payment state, not order status, so the client can't gate on status alone;
  kept as a named function so a future client-visible block can slot back in.
- **`lib/order-actions.ts`** — DELIVERED case gained a "Reopen order" action (`toStatus: "CONFIRMED"`,
  `style: "warning"`, confirm copy naming the cleared `deliveredAt`); the old BUG-ORD-01 comment
  (DELIVERED had no reopen because the API always 400'd it) is replaced with a note that the policy
  reversed 2026-08-25 and the transition is now legal server-side with a run-stop-completed 409 guard.
- **Tests** — `__tests__/order-actions.test.ts` asserts the new actions pass `canTransitionOrder` and
  DELIVERED offers exactly `[Reopen order, …]`; `order-status-flow.ts` map-parity spot-checks extended.
  `__tests__/order-status-flow.test.ts` was flipped off the old policy it pinned (DELIVERED terminal,
  no DELIVERED demotion, `canDeleteOrder` false on live statuses) onto the reversed one — DELIVERED
  steps back exactly one stage, `PENDING → DRAFT` is reasoned, `canDeleteOrder` is true everywhere.
- These mirror the server transition map/delete rules in `apps/api/src/orders/orders.service.ts`
  (`changeStatus`'s `allowed` map + `deleteOrder(id, user?)`) — see `api.md` `orders/` section.
  `order-status-flow.ts` must stay byte-parallel with that map.

### 2026-08-31 — F30 scan-loss batch (B190–B201; ONE PR, carries migration `20260910000000_order_idempotency`)

The wholesaler-reported "scanned items go missing / land twice" cluster. Server half in `api.md`
`orders/` + `buyer/`; pipeline artifacts `.claude/pipeline/2026-08-31-f30-scan-loss/`.

- **`lib/scan-loop.ts` — per-code clocks, 4-slot LRU (R1, REG-B190/B191).** `ScanGateState` is no
  longer one `{lastCode,lastAt}` pair: new exported `ScanSlot {code, lastAcceptAt, lastSeenAt}` and
  `slots?: ScanSlot[]` (MRU-first, capped at new `SCAN_SLOTS` = 4), with `lastAt`/`lastAcceptAt`/
  `lastSeenAt` now OPTIONAL top-level mirrors of `slots[0]` so legacy constructors (`ScanCamera.web.tsx`,
  untouched in THIS PR — rewired onto the gate properly by REG-B202, below) keep compiling and an
  external write RE-ANCHORS the head slot. Detections match a slot
  when their `normalizeScanCode` candidate SETS intersect (one label read as UPC-A then EAN-13 is one
  item). ⚠️ **`lastAcceptAt` moves only on ACCEPT** — refreshing it on a rejected per-frame repeat is
  precisely REG-B191 (a deliberate re-scan gets swallowed into the first scan's count); `lastSeenAt`
  moves every frame and gates on new `ABSENCE_GAP_MS` = 300 so a held code still can't re-add.
  One slot was not enough: a carton printed with two genuinely different codes (an ITF-14 case code with
  a non-zero packaging indicator does NOT normalize to its inner EAN-13) alternating A,B,A,B reset a
  single slot on every flip → REG-B190's runaway "N cs + M loose".
- **`lib/scan-pending-buffer.ts` (NEW) + `components/ScanCamera.tsx` (R2, REG-B192).** Replaces the
  drop-not-queue `busyRef`: `createPendingBuffer()`, `pushScan(state, code)` and
  `completeResolve(state)` → `{next, startResolving}`, a bounded (`PENDING_BUFFER_DEPTH` = 2) queue
  deduped by normalized code. `ScanCamera` gained `onResolvingChange?(isResolving)` and drains by
  RECURSING once `onScanned` settles, so each buffered code gets its own outcome cycle;
  `ScanOrderSheet` renders the "looking up…" indicator from it and clears it on unmount.
- **`lib/scan-ladder.ts` — the deadline ABORTS (R2).** New `SCAN_RESOLVE_TIMEOUT_MS` = 5000 wraps the
  awaited lookup in an `AbortController`, and `deps.resolve` now takes `(code, signal?)`. ⚠️ A
  `Promise.race` here would discard only the VALUE — the ladder would keep running and `deps.accept`
  (a real cart write) would land after the operator was told "try again". Scoped signal only; api-client's
  own 15s axios timeout is untouched.
  **Cross-mechanism dedup (2026-09-14, F30 open interleavings A/A'/B) — `lib/scan-accept-guard.ts`
  (NEW, pure).** A screen's camera path (this ladder) and its settled-search auto-add effect can
  both resolve the SAME physical scan independently, either double-adding or leaving the ladder
  showing a false `No product for "X"` for a line the effect already added. `sameScanCode(a,b)` (the
  same `normalizeScanCode` candidate-set intersection `gateScan` uses) plus
  `createScanAcceptGuard<T>(): {begin(code): ScanClaim<T>, offer(code,product,unitKind): boolean}` —
  one claim lives between `begin()` (an input event entering the ladder) and that invocation's own
  `settle(resolution)`; while open, `offer()` for the SAME label parks its match on the claim
  instead of adding, and `settle("unresolved")` redeems the parked match — `"accepted"`/`"refused"`
  discard it. A superseding claim for the same label TAKES an already-parked match rather than
  dropping it; a claim for a DIFFERENT label leaves the superseded one's own parked match to be
  redeemed by ITS OWN settle. Deliberately NOT a code/time window (would swallow a deliberate
  re-scan — the exact under-count `scan-loop.ts`'s 600ms cooldown and REG-B201 both guard against).
  `makeScanHandler` gains optional `deps.acceptGuard?: ScanAcceptGuard<T>` — every return path now
  routes through a local `settle(resolution, outcome)` closure; omitted on surfaces with no
  search-box auto-add (drivers, substitute-mode pickers) and every branch runs unclaimed. Wired
  into `NewOrderScreen.tsx` and `invoices/new.tsx`'s `handleBarcodeScanned`/settled-effect via a
  `scanGuardRef`, and `edit-items.tsx`. Spec: `__tests__/scan-accept-guard.test.ts`.
- **`lib/scan-feedback-slot.ts` (NEW, pure, 2026-09-14) — the scan sheet's pill is a state machine,
  not a setter pair.** Lifted out of `components/ScanOrderSheet.tsx` to close
  `scanordersheet-stale-error-pill-lingers-over-next-add`: the sheet used to write the error pill
  from ONE branch only, so a scan miss (`No product for "X"`, live Create button) sat over the
  camera for its full 8000ms actionable lifetime regardless of how many items scanned fine after
  it — a success outcome carried no feedback of its own to overwrite it with.
  `reduceScanSlot(state: ScanFeedbackSlotState, action: ScanSlotAction)`: THE RULE — a settled
  outcome always owns the slot; an error shows its pill, anything else (accept, hand-off close, a
  bare `undefined`) CLEARS it. `ScanFeedbackSlotState {pill, ttlMs, nonce}` — `nonce` climbs on
  every transition so the host's `setTimeout` (keyed on it) can't wipe a fresher pill with a stale
  expiry; `pillTtlMs` (`ERROR_PILL_MS`=2600 / `ACTION_PILL_MS`=8000) and `scanSlotEffects(outcome)`
  → `("error-cue"|"added-cue"|"scroll-tray-top"|"close-sheet")[]` (the host does haptics/scroll,
  this module stays React/RN-free). `ScanOrderSheet.tsx` now holds `slot` state and dispatches
  `{type:"outcome"|"dismiss"|"reset"|"expire"}` through it instead of its old `error`/`errorTimer`
  pair. Spec: `__tests__/scan-feedback-slot.test.ts`.
- **`lib/barcode-resolve.ts` — a distinct `archived` outcome (R5, REG-B195).** New exported
  `BarcodeResolveArchived<T> {archived: true, product, source}` widens `BarcodeResolveResult`, plus
  `archivedMessage(product)` (the one shared line) and a `signal?` parameter threaded into both rungs.
  Both rungs dropped their `isActive` filters so they agree (search rung's `limit` 10→20 to compensate),
  the ambiguity `matches` list is now SELLABLE-only (every row there is one tap from the order), and an
  all-archived match set resolves as `archived`, never `notFound`. ⚠️ **Committing callers must branch:**
  `scan-ladder`, `(driver)/route/stop/[stopId]/adjust.tsx`, `(operator)/products/stock-count/[id].tsx`,
  `(operator)/vendor-bills/new.tsx`, `components/ProductPickerSheet.tsx`. Navigate-only / read-only
  callers (`products/scan`, `products/adjust-picker`, movements) deliberately treat it as an ordinary hit —
  reaching an archived product's screen is how it gets reactivated.
- **`lib/sale-line.ts` — every boxed branch folds through `normalizeBoxesPieces` (R4, REG-B194,
  money-critical).** New private `splitFromPrev`/`piecesFromPrev`: an EXPLICIT boxes/pieces split is
  returned verbatim (a denormalized pair the operator typed is never silently re-rolled), while a typed
  PLAIN qty on a boxed product (the catalog-row qty editor writes qty and clears boxes/pieces) folds
  through the shared rollover instead of reading as an empty line. `incrementLine`, `incrementLinePiece`,
  `decrementLine` and the split setters all derive from it, so increment/decrement stay symmetric.
- **`lib/wedge-submit.ts` (NEW) + the three sale builders (R3, REG-B193/B201).**
  `createWedgeSubmitHandler(deps)` clears the search field SYNCHRONOUSLY at every SCAN submit (the web
  `CreateOrderModal` invariant) and BUFFERS a burst that arrives mid-resolve instead of concatenating it
  into the field. The clear is gated on the same `looksLikeScanCode` test `runWedgeSubmit` resolves on, so
  submitting a typed product NAME leaves the operator's search text and filtered list intact; `createAutoAddGuard()` / `createScanAttempt(guard?)` make a per-scan ATTEMPT — not a
  time window — decide whether a settle may auto-add (REG-B201). Wired through `components/NewOrderScreen.tsx`,
  `(operator)/(tabs)/orders/[id]/edit-items.tsx` and `(operator)/(tabs)/invoices/new.tsx` via refs so the
  handler's busy/queue state survives re-render.
- **`lib/order-draft-logic.ts` — `decideResumeLine(fetched)` (R5, REG-B195).** Three outcomes and only one
  removes anything: fetched OK → KEEP **including archived** (`/products/:id` returns `isActive:false` rows
  where the catalog list filters them out, so a parked scanned line used to come back as "no longer in your
  catalog" and vanish); 404 → drop; anything else (timeout/5xx/offline) → `failed: true`, abort the whole
  hydration so autosave can never PATCH a truncated cart over the draft. `NewOrderScreen`'s resume block
  flags the kept line as Archived rather than deleting the operator's work.
- **Never-silent offline queue (R6, REG-B143/B111)** — `lib/queue-drain.ts` (NEW) + `store/offlineQueue.ts`
  - `hooks/useNetworkSync.ts` + `components/OfflineBanner.tsx` (NEW, mounted by `(driver)/_layout.tsx` and
    `(operator)/_layout.tsx`). See the "Offline queue (driver)" row in the table at the top of this file.
- **iOS toast has a sink (R7, REG-B151)** — `lib/toast-host.ts` (NEW: `registerToastHost` /
  `releaseToastHost` / `getToastHost`); `lib/toast.ts`'s iOS branch is no longer a no-op — it routes to the
  registered host, falling back to `Alert.alert`. ⚠️ Registration lives in `useInlineToast` itself
  (`components/InlineToast.tsx`), not in each screen, so a new `<InlineToast>` owner cannot forget it.
- **Idempotent submit (R8, REG-B196)** — `lib/order-submit-key.ts` (NEW) mints one uuid per CART SESSION
  (`getOrderSubmitKey()`), surviving every FAILED attempt on that cart and reset only once a submit lands
  (`resetOrderSubmitKey()`). `lib/api/orders.ts` `useCreateOrder` takes `idempotencyKey?` and sends it as the
  `idempotency-key` **HEADER, never in the body** (same idiom as `useCompleteWithPayment` in `lib/api/routes.ts`);
  `lib/api-client.ts` carries replay-safe headers across an offline replay. Server contract in `api.md` `orders/`.
- **B215/R3 — submit keys are held PER CUSTOMER (2026-09-11, round 2).** `lib/order-submit-key.ts` keeps a
  `Map<customerId, key>`: `getOrderSubmitKey(customerId)` mints on first use for that customer,
  `resetOrderSubmitKey(customerId)` clears one slot, `clearAllOrderSubmitKeys()` is the explicit cart-clear path,
  and a null/undefined customer uses a `__none__` slot. This matches the server's customer-scoped replay identity
  without rotating anything on "Change customer" — the round-1 `keyCustomerIdRef` + onPick rotation is GONE,
  because rotating on A→B→A handed A's still-live cart a fresh key and re-opened the duplicate window its own retry
  needed collapsed. `NewOrderScreen` passes the selected `customerId` at the submit site, the mount reset, the
  success reset and the 409 "Open order" wind-down; that 409 branch now also accepts
  `IDEMPOTENCY_REPLAY_NEEDS_RECONCILE` (same "Open order" action). Tests:
  `__tests__/order-submit-key.test.ts` (6 pure cases incl. A→B→A and reset-isolation) plus the source pins in
  `__tests__/api-client-timeout.test.ts`.
- **B215 — a customer switch is a NEW cart session; a spoken-for key offers the held order (2026-09-11,
  train 4 Run B)** — the submit key's replay identity is CUSTOMER-SCOPED on the server, so carrying one
  customer's key onto another's cart made the submit look like a replay of an order that is not theirs
  (now a hard 409). `components/NewOrderScreen.tsx` keeps a `keyCustomerIdRef` — stamped with the outgoing
  customer in `onChangeCustomer`, read in `CustomerPickerView`'s `onPick`, which calls `resetOrderSubmitKey()`
  ONLY when the newly picked id differs. ⚠️ Re-picking the SAME customer must keep the key, or a genuine
  retry mints a sibling duplicate order — which is why the rotation lives in `onPick` (the only place the new
  id is known), not in `onChangeCustomer`. `lib/order-submit-key.ts`'s doc comment lists this as reset
  condition (3) beside successful-submit and explicit-cart-clear. The submit `onError` handler gained a branch
  beside `MERGE_CHOICE_REQUIRED`: a 409 whose body carries `code: "IDEMPOTENCY_KEY_CONFLICT"` + `orderId`
  raises a "This cart was already submitted" `chooseAction` with **Open order** (→ `resetOrderSubmitKey()`,
  `finalizeBoundDraft()`, `router.replace('/(operator)/orders/<orderId>')` — the same wind-down as the success
  path) and Cancel, instead of wedging the screen on a bare message the operator cannot act on. No pure helper
  was extracted for the rotation predicate, so it is covered by the manual row `REG-B215-M1` in the run's
  `build-plan.md`. Server half + the 409 body shape in `api.md` (B215).
- **`lib/api-client.ts` — an online timeout is not "offline" (REG-B196)** — see the "API base client" row above.
- **Buyer scan-to-cart — the client leg of R12 (REG-B200)** — `lib/api/buyer.ts`
  `resolveBuyerProductByCode(code, signal?)` → `{product} | {notFound:true}` calls the buyer realm's own
  rung `GET /buyer/products/scan/:code` (`api.md` "buyer catalog scan"); a 404 is the MISS outcome
  ("no candidate matched" and "matched a product this buyer may not see" are deliberately
  indistinguishable), anything else propagates so the caller says "try again" instead of a false
  "not found". ⚠️ `lib/barcode-resolve.ts` is NOT usable from the buyer realm — both its rungs are
  `@Roles(OPERATOR, DRIVER)` — which is why this is a separate function on `buyerApiClient` rather than a
  branch inside it. Consumed by NEW `app/(customer)/scan.tsx` — the first customer-side scan affordance
  (`BarcodeScanner continuous`, entered from a `barcode-outline` NavBar button on
  `(customer)/(tabs)/catalog.tsx`). ⚠️ A pushed sibling Stack screen, NOT an in-tab `BarcodeFab` overlay:
  the tab bar is rendered outside the tab screen, so an absolute-fill overlay inside `(tabs)` leaves the
  camera sitting under it. A hit is added through the SAME `cartStore.add` the catalog tile's + button
  uses (same fields, one selling unit, so a re-scan increments the line instead of duplicating it), and
  the lookup is wrapped in `SCAN_RESOLVE_TIMEOUT_MS`'s `AbortController` for the same reason the operator
  ladder is — an abandoned resolve must never add the item after the buyer was told the scan failed.

### 2026-08-31 — REG-B202: port the F30 scan engine into `ScanCamera.web.tsx`

`ScanCamera.web.tsx` was deliberately skipped by the F30 batch above and kept three defects native
removed: **decode starvation** (its rAF loop awaited the FULL resolve via `fire(code)` before
releasing `inFlightRef`, so no frame was even decoded mid-resolve — buffering fixes nothing if the
buffer is never offered a code), **drop-not-queue** (`fire()`'s `busyRef` bailed BEFORE the gate,
discarding arrivals with zero feedback — REG-B192 verbatim), and **legacy re-anchor** (its `finally`
wrote `gateRef.current = {lastCode, lastAt: Date.now()}` on every settle, pinning the gate to the
single-slot shape and defeating `scan-loop.ts`'s multi-slot cooldown).

- **`lib/scan-engine.ts` (NEW, pure, platform-free).** The sequencing seam: `ScanEngineState
{gate: ScanGateState | null, buffer: PendingBufferState}`, `createScanEngine()`,
  `frameScanned(state, code, now) → ScanEngineStep {next, startResolving, indicator}` (gates via
  `gateScan` FIRST — always keeps the returned gate state, even on reject, so a rejected repeat's
  clock still advances — then `pushScan`s on accept), `manualScanned(state, code)` (skips the gate
  entirely, still `pushScan`s — the actual W3 fix: a manual submit mid-resolve is buffered, not
  dropped), `scanSettled(state)` (`completeResolve` + drain). `indicator` is `"on"`/`"off"` only on
  the buffer's `isResolving` EDGE, `null` otherwise. No dedupe/capping/clock of its own — those stay
  owned by `scan-loop.ts`/`scan-pending-buffer.ts` respectively. Spec: `__tests__/scan-engine.test.ts`
  (built RED-first against a signature-only stub, per this repo's F30 convention).
- **`components/ScanCamera.web.tsx` rewired.** `busyRef` + `gateRef` → one `engineRef =
useRef(createScanEngine())`; new `onResolvingChange?(isResolving)` prop (mirrors native). `fire()`
  split into sync `handleFrame`/`handleManual` (thread one event through the engine, kick off
  `resolveCode` when `startResolving` is set) + async recursive `resolveCode` (mirrors
  `ScanCamera.tsx`'s drain; web's `outcome?.close → stop()` branch is preserved, but the drain after
  it is now UNCONDITIONAL like native, not special-cased). The decode loop's `.then()` now calls
  `handleFrame` SYNCHRONOUSLY and releases `inFlightRef` in `.finally()` as soon as the decode
  settles — no longer nested inside the resolve's own await, which is what starved the decoder.
  `submitManual` now calls `handleManual` directly (no `deliberate` flag needed — the gate is never
  reached by that path).
- **`lib/scan-loop.ts` — a pre-existing, unrelated stale-comment note.** Its `ScanGateState.lastAt`
  doc still frames the top-level mirror as accommodating `ScanCamera.web.tsx`'s legacy write; that
  write is now gone (see above). Left as-is since `scan-loop.ts` was out of scope for REG-B202 and
  the mirror fields still have a legitimate purpose (any external caller building a raw `{lastCode,
lastAt}` state).
- **`lib/scan-feedback.ts` + `lib/scan-cue.ts` / `lib/scan-cue.web.ts` (NEW) — the web accept cue.**
  `cueForOutcome(outcome) → "accepted" | "rejected" | "none"` is the pure decision (added/error/
  everything-else), kept apart from the player so it unit-tests in node Jest. `scan-cue.web.ts`
  plays a short WebAudio blip (1000Hz/80ms accept, 300Hz/180ms reject) over ONE lazily-created,
  reused `AudioContext` plus `navigator.vibrate`; `unlockScanCue()` resumes the context and is
  called from the camera-start effect (mount already implies a user gesture, so it satisfies the
  autoplay policy). `scan-cue.ts` is the native no-op sibling — resolved by the bundler's
  platform-suffix rule, same convention as `location-tracker.*`; it deliberately does NOT wire
  `lib/haptics.ts`'s `scanHaptic`, which already covers native at the SHEET level
  (`ScanOrderSheet`, stock-count) and early-returns on web. ⚠️ Both cue modules are TOTAL — a cue
  is pure ergonomics and must never fail a scan, so `ScanCamera.web.tsx` calls `playScanCue` as a
  read-only observation on an already-resolved outcome, never inside the engine.
  ⚠️ **Testing trap:** asserting `.not.toThrow()` on the web player in a bare node env proves
  NOTHING — with no `window` the beep returns early and `navigator.vibrate?.()` optional-chains
  away, so the test passes even with the try/catch deleted (verified by mutation). The pins
  (REG-B202/CUE10-14) install a host whose AudioContext constructor THROWS.
- **`lib/build-info.ts` (NEW) + `Dockerfile` + `app/(auth)/login.tsx` — the build stamp.**
  `shortBuildSha(raw)`/`buildLabel(raw?)` are the single source of truth for the display string:
  a hex string ≥7 chars shortens to 7 lowercase, a human-set tag (`local`, `v1.1.0`) survives
  as-is, blank/undefined reads `"dev"`. `BUILD_SHA` reads `process.env.EXPO_PUBLIC_BUILD_SHA` at
  MODULE SCOPE via a literal static member access — ⚠️ Expo's babel plugin inlines `EXPO_PUBLIC_*`
  by literal text replacement, so a computed lookup would silently read `undefined` in the shipped
  bundle. The Dockerfile adds `ARG EXPO_PUBLIC_BUILD_SHA` + `ARG RAILWAY_GIT_COMMIT_SHA` with
  `ENV EXPO_PUBLIC_BUILD_SHA=${EXPO_PUBLIC_BUILD_SHA:-$RAILWAY_GIT_COMMIT_SHA}` before the export.
  VERIFIED 2026-08-31 (#562 deploy): Railway DOES forward `RAILWAY_GIT_COMMIT_SHA` into the build,
  so no service variable is needed — the deployed bundle carried the full merge sha. If a deploy ever
  renders "build dev", add `EXPO_PUBLIC_BUILD_SHA=${{RAILWAY_GIT_COMMIT_SHA}}` on routeflowmobile. Rendered on the login screen in `ios.label2` (NOT the fainter `label3` — the
  stamp exists to be read aloud by a client confirming their deploy, so it must clear a contrast
  floor). Inlining verified end-to-end against a real `expo export --platform web`.
- ⚠️ **Local `expo export --platform web` needs `NODE_PATH=$(pwd)/node_modules`** or it dies with
  `Invalid call ... process.env.EXPO_ROUTER_APP_ROOT` — the same babel-preset-expo/expo-router
  resolution class the Dockerfile already pins with `ENV NODE_PATH` (commits fdf60a49/7cab3863). A
  warm Metro cache masks it; `--clear` exposes it. Not a defect in this change.
- **Registry: B202 closed via #562 (2026-09-07 bookkeeping).** This section already documented the
  fix in full; the bug-registry row itself carried no ledger entry until this bookkeeping pass —
  `move`/`prove`/`discharge` added F30.jsonl's missing B202 row (tier T1, proof REG-B202 +
  REG-B202/CUE1-14) and moved it `done` against PR #562. See `.claude/campaign/bugs/B202.md`.

### 2026-08-31 — Native-only launch blockers found by running the first APK (B203/B204)

The first APK ever installed (emulator, Android 14) surfaced two defects invisible on mobile web
because web never links the native modules:

- **B203 — `expo-file-system` major-version pin crashed launch.** `~18.1.11` vs SDK 55's
  `~55.0.26`: the old native module predates `FilePermissionModule`, which expo-modules-core 55
  loads at startup → `NoClassDefFoundError`, fatal, pre-UI. The pin existed for the legacy
  `downloadAsync`/`writeAsStringAsync`/`cacheDirectory` API used by ONE file (`lib/share-pdf.ts`);
  SDK 54 moved that API to **`expo-file-system/legacy`**, which is where it now imports from.
  ⚠️ npm left a stale nested 18.1.11 under `apps/mobile/node_modules` that it itself reported
  `invalid` — it had to be deleted from BOTH the tree and the lockfile before `npm install`
  resolved one deduped copy.
- **B204 — SecureStore rejects every app storage key; buyer boot gate froze forever.**
  `expo-secure-store` validates keys against `/^[\w.-]+$/` on reads AND writes; every key is
  colon-namespaced (`auth-keys.ts`: `rf:op:accessToken` …), so on device every session
  read/write threw. `buyer-session-store.initialize` was the only boot store with no catch and
  the root layout's `bootstrapping` gate ANDs all three stores → eternal splash spinner; even
  unfrozen, no login could persist. **Fix = native-only spelling change**: new pure
  `lib/secure-key.ts#toSecureStoreKey` (`:` → `_`) wrapped around every native SecureStore call —
  22 call sites across 8 files (`auth.ts`, `api-client.ts`, `buyer-auth.ts`, `tenant-store.ts`,
  `last-username.ts`, `useSocket.ts`, `useBuyerSocket.ts`, `google-callback.tsx`) — swept to zero
  unwrapped `*ItemAsync(` calls. Web keeps its exact keys (nobody signed out); there was no
  native install base, so no migration. ⚠️ EVERY new native SecureStore call MUST route through
  `toSecureStoreKey`; `__tests__/secure-key.test.ts` pins the real key set collision-free and
  the buyer gate's throw-resilience (written RED against the unhardened store).

### 2026-08-31 — Native build & distribution (EAS Android + OTA)

The first EAS config that can actually produce an installable build. Until now the ONLY way a
client got this app was mobile web (`Dockerfile` → `expo export --platform web` → nginx on
Railway, phone-UA-proxied behind `www.routeflow.info` by `apps/web/middleware.ts`); the single
native build ever attempted (2026-04-20) died in EAS's Install-dependencies phase and produced
no artifact.

- **`app.json`** — `version 1.1.1`; `android.versionCode` DELETED 2026-09-01 (the counter is
  REMOTE now — see the 2026-09-01 section below). NEW config plugins for
  `expo-camera`, `expo-location`, `expo-image-picker`: all three were dependencies with no
  plugin, so a native build shipped without their permissions. ⚠️ `expo-location` MUST carry
  `isAndroidBackgroundLocationEnabled` + `isAndroidForegroundServiceEnabled` — the library
  manifest adds neither, and `lib/location-tracker.native.ts` runs `startLocationUpdatesAsync`
  with a foreground service, so driver tracking degrades silently without them. iOS usage
  strings ride along in the same plugin props.
  ⚠️ **`android.blockedPermissions: [RECORD_AUDIO]` is load-bearing.** The camera plugin's
  `recordAudioAndroid: false` only stops the PLUGIN adding it; `expo-camera`'s own library
  manifest declares it, so the merger re-adds it. Nothing here records audio or video.
- **OTA (`updates.url` + `runtimeVersion.policy = "appVersion"`).** ⚠️ Must be present in a
  binary for that binary to ever receive an update — adding it later does not reach installs
  already in the field. Policy is `appVersion`, NOT `fingerprint`: `app.config.js` injects
  `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` into the react-native-maps plugin, so a fingerprint computed
  with that var unset differs from one computed with it set and updates strand silently.
- **`eas.json`** — `staging` is the retest profile (internal + apk + production API) and carries
  `channel: "staging"`; `production` carries its own. All profiles pin `node: "20.19.4"` (that
  is the lever that fixes the builder's bundled npm to 10.8.x, matching this repo's
  `packageManager` — the npm that wrote the lockfile) and set `HUSKY: "0"` (the root
  `prepare: husky` runs on the builder, whose uploaded archive has no `.git`; husky v9 errors —
  the leading suspect for the April 8.5-second install failure).
- **Deleted the repo-ROOT `eas.json` + `app.json`** — a second, conflicting EAS identity
  (projectId `0196542f…`, bundle `com.najathakram1.routeflow`, `appVersionSource: "remote"`)
  referenced by nothing. An `eas` command run from the root silently targeted the wrong project.
- ⚠️ **`npx expo prebuild` REWRITES `package.json`'s `android`/`ios` scripts** to
  `expo run:android`/`run:ios` (bare-workflow assumption). This is a managed project — revert
  those two lines after any prebuild, and never commit the generated `android/` directory
  (its presence flips EAS to the bare workflow and `app.json`'s plugins stop applying).
- ⚠️ **EAS installs MUST set `npm_config_engine_strict=false`** (in every `eas.json` profile's
  `env`). The root `.npmrc` sets `engine-strict=true`; EAS copies it into the build and runs
  `npm ci --include=dev` from the workspace ROOT, so apps/api's tree installs too and
  `@prisma/streams-local` (dev-only, `node>=22`) turns into a hard EBADENGINE — **this is what
  killed the 2026-04-20 build and the first 2026-08-31 attempt**, in the Install-dependencies
  phase both times. `@zxing/library` (`node>=24`) is a second one waiting behind it. ci.yml
  already solves this with `npm ci --engine-strict=false`; the Dockerfiles escape it only because
  they never COPY `.npmrc`. Correct behaviour = these appear as `npm warn`, not `npm error`.
- **Reading a failed EAS build's logs** (they are NOT in the CLI): POST to `api.expo.dev/graphql`
  with the `expo-session` secret from `~/.expo/state.json` and a NON-default `User-Agent`
  (Cloudflare 403s urllib's default with `error code: 1010`), query
  `builds{byId(buildId:$id){status error{message} logFiles}}`, then fetch `logFiles[0]` — it is
  **Brotli**-encoded JSON-lines keyed by `phase`. The signed URLs expire quickly, which is why
  the April failure went undiagnosed for four months.
- Install any dep here with `npx -y npm@10.8.0` — the local npm 11 rewrites lockfile metadata.
  `npm run validate-lock` (`missing 0`) is the gate.

### 2026-09-01 — Native Google Sign-In repair + SDK-55 module alignment (`fix/mobile-google-signin-sdk55`)

The owner-approved publish-readiness fix PR (HANDOFF.md banner 2026-09-01).

- **`(auth)/google-callback.tsx`** — both `await import("expo-secure-store")` sites destructured
  `{ default: SecureStore }`; the package has 14 named exports and **no default export**, so on
  native every `getItemAsync`/`setItemAsync` call ran on `undefined` → **Google Sign-In was
  completely broken on every native build** (web fine via the localStorage branch — exactly
  L-025's untested-platform-branch class). Both sites now bind the module namespace (the
  dynamic-import equivalent of `lib/auth.ts:1`'s `import * as SecureStore`).
- **Five native modules re-pinned to SDK 55's bundled versions** (B203's crash class):
  `expo-location ~55.1.14` (was ~19), `expo-task-manager ~55.0.20` (was ~14),
  `expo-sharing ~55.0.24` (was ~13), `@react-native-async-storage/async-storage 2.2.0`
  (was ^3 — AHEAD of SDK 55, not behind), `@react-native-community/netinfo 11.5.2` (was ^12).
  All five live ONLY in `apps/mobile/package.json` — root `overrides` never pinned any of them
  (the HANDOFF banner's "three of them" claim was checked and is wrong). ⚠️ Still never
  `expo install --fix` here: it would also touch the root-override-pinned RN packages and the
  override silently wins on `npm ci` (L-012).
- **Deleted `react-native-worklets-core`** — imported nowhere (grep: zero source hits), absent
  from `bundledNativeModules.json`, and autolinked a SECOND JSI worklets runtime beside
  `react-native-worklets@0.7.4` (which stays, root-pinned).
- **`expo.install.exclude: ["jest", "@types/react"]`** added to `package.json` — both are
  deliberately held back, so `expo install --check` can now become a CI gate instead of
  exiting 1 forever.
- **Versioning is REMOTE:** `app.json` `version 1.1.1` with `android.versionCode` deleted;
  `eas.json` `cli.appVersionSource: "remote"`; the remote counter is seeded once at 5 via
  `eas build:version:set` (next build = versionCode 6). The old `local` source + production
  `autoIncrement: true` was a duplicate-versionCode generator — the cloud builder increments a
  local file it then discards, parallel worktrees can't see each other's counter, and Play
  rejects a reused versionCode outright. Safe because `runtimeVersion.policy` is `appVersion`
  (the documented remote-source incompatibility is `nativeVersion`).

### 2026-09-04 — F13 recurring-invoice run outcome (REG-B106, operator parity)

- **`lib/recurring-invoices-logic.ts`** — new `type LastRunStatus = "SUCCESS" | "FAILED"`,
  `interface LastRunOutcome {variant: PillVariant; label: string; detail?: string}` and pure
  **`lastRunOutcome(t): LastRunOutcome | null`** — the mobile mirror of web's recurring list card.
  Returns `null` when there is nothing honest to show (no run yet, or a legacy row that ran before
  outcomes were recorded, i.e. `lastRunStatus` null): the date alone is shown and no claim of
  success is made. FAILED → red pill + the recorded `lastError` as detail; SUCCESS → green pill.
- **`lib/api/recurring-invoices.ts`** — `RecurringInvoice` gains `lastRunStatus?: "SUCCESS"|"FAILED"|null`
  and `lastError?: string|null` (mirrors web's `lib/api/invoices.ts`).
- **`app/(operator)/recurring-invoices/[id].tsx`** — renders `lastRunOutcome(template)` as a `Pill`
  plus the error detail line under the schedule text. **No retry button here** (there never was
  one), so mobile needs no equivalent of web's `isRetryableRunFailure` gate — recorded as an
  accepted API/mobile asymmetry, not a gap.
- **`__tests__/recurring-invoices-helpers.test.ts`** — adds `describe("REG-B106 lastRunOutcome")`
  with T22a (no run / status null → null), T22b (FAILED → red + detail), T22c (SUCCESS → green).

### 2026-09-07 — F16 list caps / silent truncation (B110, #656)

- **`lib/api/customers.ts`** — `CustomerStatement` (buyer statement) and `AccountSummary`
  (operator statement) both gain `transactionsTruncated: boolean` — true when the server's
  `transactions` ledger read hit its own `take` cap (mirrors web/`packages/types` `buyer.ts`).
- **`app/(customer)/payments.tsx`** — the "Store credit" `Tile`'s sub-label and the "Active
  credits" card's visibility now key on `hasActiveCredit = (statement?.availableCredit ?? 0) > 0`
  (the server's uncapped total), never `credits.length` (a reduce over the capped `transactions`
  array) — `credits.length > 0 ? "N active" : "None available"` became `hasActiveCredit ?
"Available" : "None available"`, dropping the count. New `truncationNote` style renders "Showing
  the most recent transactions only — older entries are not listed in this ledger." above the
  credit rows when `statement?.transactionsTruncated` is true.
- **`app/(operator)/customers/[id]/statement.tsx`** — same truncation note (new `truncNote` style)
  rendered above the transactions list when `data.transactionsTruncated === true`; silent
  (no label) otherwise.
- Web equivalents: `apps/web/app/(dashboard)/customers/[id]/ledger-truncation-note.tsx`
  (`LedgerTruncationNote`) and the buyer `finances/page.tsx` note — see `web.md`.

### 2026-09-08 — B246 option C: scan FAB on the order-edit line list (#668)

- **`app/(operator)/(tabs)/orders/[id]/edit-items.tsx`** — the line-list branch (alongside the
  `ProductPicker` scan surface, an exclusive alternative branch) now mounts `BarcodeFab`: `hidden=
{scanFabHidden({ pricingReady, pickerOpen: showPicker, priceModalOpen: !!priceEditItem,
blockingModalOpen: unlistedModalOpen || createCreditOpen || !!licenseBlock || !!creditBlock })}`,
  `onPress` sets new state `pickerScanIntent` true and calls `setShowPicker(true)` — never opens
  its own overlay. The local `ProductPicker` function gains `initialScanOpen?: boolean`, seeding
  `scanOpen = useState(initialScanOpen ?? false)`; its mount passes
  `initialScanOpen={pickerScanIntent}`; `pickerScanIntent` resets to `false` on both picker-close
  paths so the plain "Add product" entry still opens cold. Net: Apply → FAB → camera, 1 tap after a
  price edit (was 2 after Apply, and the registry's original "6 taps" claim was refuted by
  measurement — the real pre-fix path was Apply → Add product → barcode icon = 3 taps). No new
  pricing path: `onPickAndStay`/`onPick` still route through the existing `addPickedToDraft`.
- **`lib/scan-fab-visibility.ts`** (new) — `scanFabHidden(input: { pricingReady, pickerOpen,
priceModalOpen, blockingModalOpen }): boolean`, `!(pricingReady && !pickerOpen &&
!priceModalOpen && !blockingModalOpen)`. `blockingModalOpen` (unlisted-item, credit-note, licence
  guard, credit-limit guard) is a 4th flag added during the fix's round-2 hardening, beyond
  cause-ruling.md's original 3-flag plan — trust the code over the plan doc. `pricingReady` is the
  REG-B62 guard: nothing scan-shaped may act before the customer's contract loads.
- **`components/BarcodeFab.tsx`** — `Props` is now a discriminated union on top of `Base =
{hidden?, continuous?}`: exactly one of `onScanned: (code: string) => ScanOutcome |
Promise<ScanOutcome>` (opens this component's own camera overlay) or `onPress: () => void`
  (intercepts the tap, opens nothing here — the caller routes into its own scan surface); the
  other is typed `?: never` in each branch. Was: both handlers independently optional, so
  `<BarcodeFab />` with neither compiled into a permanently inert 56px button (the exact B246
  defect, moved into the shared component's type — L-095). `handlePress` checks `onPress` first,
  falls back to opening its own scanner only when absent.
- Tests: see the Tests section's `#668` bullet above (`edit-items-scan-fab.test.ts`,
  `scan-fab-visibility.test.ts`, `barcode-fab-props.test.ts`, `scan-camera-web-sequencing.test.ts`).
  Final gate: 115 suites / 1435 tests (`npx jest --silent`, apps/mobile), lint 0 errors. No mobile
  renderer on the pipeline host, so no UI-verify ran — the owner exercises the FAB on a device
  after the next EAS build.
- **Registry:** B246 moved into `F30` (tier T1, the mobile-scan wave — same file family as B202),
  proven + discharged on #668 (master `7fc01298`). B245 moved into `F30` alongside it, discharged
  as a pin (no code change — see L-025). Sibling sweep (`useState.*scanOpen` across
  `app/**`/`components/**`) filed **B264–B266** (unbatched, low): `purchase-orders/record.tsx`,
  `(tabs)/invoices/[id]/edit.tsx`, `customers/[id]/standing-orders/new.tsx` — each imports
  `ProductPickerSheet` with no parent-level scan affordance of its own. **B263** (unbatched, high)
  files the deferred Option-B twin — price control inside the scan flow over a PAUSED camera
  (`ScanOrderSheet` on the edit screen); `ScanCamera`'s `active` pause prop stays unreachable today
  because `BarcodeScanner` (its only caller) never passes one.

### 2026-09-08 — B263 option B: price edit inside the scan flow over a paused camera (#675, `f52005f3`)

Companion to "B246 option C" above — that PR shipped the FAB (Apply → FAB → camera, 1 tap); this
one removes the remaining friction by letting the price edit happen WITHOUT leaving the picker at
all (scan → Edit price → Apply → scan next, 0 remounts). Was 5 taps + 2 camera lifecycles
end-to-end before either fix.

- **`lib/price-override.ts`** (new, pure) — `applyPriceOverride(item, { unitPrice, reason }):
DraftItem` returns the item with `unitPrice: roundMoney(unitPrice)`, `overrideReason: reason`,
  and `lineTotal` recomputed via `computeLineSubtotal` (boxes/pieces/`freeUnits` preserved,
  `@routeflow/pricing`). Both the line-list branch's `PriceOverrideModal` and the new picker-branch
  one call it — this also fixes a pre-existing money-math gap where the list-branch modal wrote
  the typed price unrounded. `needsMarginAck(item, newPrice, floorPrice): boolean` is the same pure
  decision helper now backing the margin-floor ack on both branches.
- **`app/(operator)/(tabs)/orders/[id]/edit-items.tsx`** — `ProductPicker` gains `canEditPrice`,
  `marginFloor`, and `onScanSessionStart` props and new state `pickerPriceEditItem`; on a
  successful scan-add it shows a "last added: `<name>` · `<price>` · Edit price" strip, and tapping
  Edit price opens the SAME `PriceOverrideModal` used by the line-list branch (`onSave` →
  `applyPriceOverride` → the shared `updateDraftItem` setter) over the live camera, now paused via
  `<BarcodeScanner active={!pickerPriceEditItem} …>` — no remount, no track teardown. The strip's
  margin-floor label derives from `computeMarginFraction`/`classifyMargin` (the same calls
  `DraftItemCard` uses via the new `marginFloor` prop, itself the list row's own
  `floorForCategory(marginConfig, category)`) instead of a hardcoded literal, so the two surfaces
  cannot disagree on wording (round-3 light-loop fix, caught after the engine's main pass). The
  strip clears on camera close or a row tap. `canEditPrice` gating itself (`!isDriver &&
order.status !== "CANCELLED"`) is UNCHANGED on the list branch — no new gate, no SPECIAL-tier
  change.
- **`components/BarcodeScanner.tsx` + `.web.tsx`** — see the "Barcode scanner" table row above
  (`active` pause prop + `feedback.action` pill). The dead `onAmbiguous`/`onCreate` hand-off this
  fixes was found independently while implementing D1 and folded into this same PR rather than
  filed separately.
- Tests: see the Tests section's `#675` bullet above (`price-override.test.ts`,
  `edit-items-scan-price.test.ts`, `barcode-scanner-active.test.ts`). Red gate before the fix: 18
  failed / 0 passed / 1 skipped (`PIN-B263-D4`) on `-t "REG-B263"`. No mobile renderer on the
  pipeline host, so no UI-verify ran — the owner exercises it on a device after the next EAS build.
- **Registry:** B263 moved into `F30` (tier T1, B246's batch), analysis sections filled from
  cause-ruling.md, proven (PR #675) and discharged (master `f52005f3`) — done. B246's row
  notes the option-B twin landed. Sibling money-math gap found in review — the margin-floor gate
  (`needsMarginAck`, rounds to the nearest cent) and the list/picker label (`classifyMargin`, exact
  fraction) can disagree by up to half a cent at the boundary — filed unbatched as **B280** (low,
  sensitive/money hand-set: `classify()` only scans title+location and neither string trips the
  money regex, corrected in the row frontmatter then `bugs.mjs index` resync'd `bugs.jsonl`).
  Lessons: L-099 appended (domain — a sheet returning to a live surface mounts over it with a pause
  prop, never swaps the surface out); L-038 archived for headroom (tooling, bot-authored lockfile
  regeneration — no dedicated automated guard, grep-confirmed clean of citations outside
  `.claude/lessons/**`/`.claude/pipeline/**`). Register back to 40/40.

### 2026-09-09 — Train 1 session teardown/hydrate + POD reconcile (B111/B136/B137/B140/B150, #681, `8de65863`) / Train 2 push toggle + product-picker archived guard (B04/B142, #682, `7d8141e0`)

- **`lib/session-teardown.ts`** (new) — `TeardownReason = "logout" | "session-expired" |
"cross-tab"`; `TeardownOptions { reason?, userId?: string | null }`;
  `teardownUserSession(options?): Promise<void>` is the ONE place every user-scoped side effect of
  ending a session lands — called by `useAuthStore.logout()` BEFORE `apiLogout()` (tokens still
  valid) and by the session-expired handler. Resolves the outgoing `userId` FIRST (falls back to
  `getStoredUser()`), then: `stopLocationTracking()` unconditionally for both realms (B150),
  `queryClient.cancelQueries()` + `.clear()` on the shared `lib/query-client.ts` instance (B140),
  `reset()` on all 7 user-scoped stores (`podStore`, `runSettlementStore`, `mileageStore`,
  `routeStore`, `delivery-plan-store`, `listUiStore`, `productPickerStore`, via a defensive
  `resetIfPresent`), then `clearUserScopedStorage(POD_STORE_NAME | RUN_SETTLEMENT_STORE_NAME,
userId)` to delete the two persisted blobs outright (a `persist` write from the `reset()` calls
  above can otherwise land in the `anon` bucket one async hop later and resurrect the cleared
  capture). Deliberately untouched: the tenant store (shared-tablet branded login survives
  sign-out) and the offline queue (identity-stamped, never flushed on sign-out).
  **Driver-durability lane, Lane B half (2026-09-14) — now 8 stores + a per-order keyspace
  sweep.** `store/stopCartStore.ts` (NEW, see below) joined the original 7 — same
  `reset()`/persisted-blob pattern via `STOP_CART_STORE_NAME`. New step (6):
  `lib/edit-items-draft.ts`'s staged order-edit snapshot is one AsyncStorage key PER ORDER
  (`rf.edit-items.v1:<userId>:<orderId>`, RULINGS R1), not a single blob, so it can't be
  addressed by `clearUserScopedStorage`; a new private `clearStorageByPrefix(prefix)` enumerates
  `AsyncStorage.getAllKeys()` and `multiRemove`s every key under
  `editItemsSnapshotUserPrefix(userId)` instead (best-effort, swallowed) — otherwise a staged
  edit the outgoing operator left behind could be offered for restore to the next login on a
  shared device (the B136/B137/B140 class). **2026-09-14 (PR #748 review, F1):** step (6) now
  ALSO sweeps `editItemsSnapshotUserPrefix(null)` (the anon bucket) belt-and-braces, since
  `edit-items.tsx`'s write ref could reach it whenever `userId` was undefined at write time
  (cold open/deep link, before auth resolves) — the write ref itself now refuses to write at all
  in that state, so this sweep only ever needs to catch a pre-existing key.
- **`lib/session-hydrate.ts`** (new) — `rehydrateUserScopedStores(): Promise<void>` calls
  `persist.rehydrate()` on `podStore`/`runSettlementStore` (both now `skipHydration: true`,
  keyed by user id which isn't known at module-eval time); the ONE explicit hydration point,
  called from `lib/auth-store.ts` right after `login()`/`initialize()` resolves the user.
  Optional-chained and swallowed per store — a hydration failure never blocks sign-in.
  **2026-09-14:** now also rehydrates `useStopCartStore` (3 stores total) — same reason, same
  `skipHydration: true`/user-keyed-storage shape.
- **`lib/query-client.ts`** (new) — `export const queryClient = new QueryClient()`, the single
  instance shared by `app/_layout.tsx`'s `QueryClientProvider` and `session-teardown.ts` (a client
  the layout allocated for itself would leave sign-out unable to clear it).
- **`lib/pod-reconcile.ts`** (new, pure) — `PendingArtifactCandidate { artifactId, dataUrl }`,
  `ServerPodStop { podArtifactIds?: string[] }`; `pendingPodArtifacts(local, serverStop):
PendingArtifactCandidate[]` filters out local artifacts the server already holds (matched by
  id) so a relaunch re-attaches only what's missing, never a duplicate append (B111/B136).
  `artifactIdsFromPodPhotoUrls(urls): string[]` recovers those ids from a stop's
  `podPhotoUrls` via the `/photo-<artifactId>.` key marker
  (`apps/api/src/routes/pod-artifacts.util.ts#podArtifactKey`).
- **`lib/queue-identity.ts`** (new) — `QueueIdentity`, `stampQueuedAction(action, identity):
StampedAction`, `resolveQueueIdentity(): QueueIdentity | null`, `filterQueueForCurrentUser(...)`,
  `selectFailedActionsForUser(...)`, `settleQueueOwnership(...)`. `store/offlineQueue.ts` stamps
  every new entry with `{userId, tenantId}` at enqueue time (legacy unstamped entries adopted once
  at drain time via `restampAction`); drain skips an entry stamped for a different user, moving it
  to `failedActions` with reason `different-user` (B137) instead of replaying it.
- **`lib/user-scoped-storage.ts`** (new) — `userScopedStorageKey(baseName): Promise<string>`,
  `userScopedStorageKeyFor(baseName, userId)`, `clearUserScopedStorage(baseName, userId):
Promise<void>`, and the zustand `StateStorage` adapter `userScopedStorage` — keys
  `podStore`/`runSettlementStore`'s persisted blobs by user id (`routeflow-pod-store:<userId>`).
- **`store/podStore.ts`** / **`store/runSettlementStore.ts`** — both now `persist` via
  `createJSONStorage` on `userScopedStorage`, `skipHydration: true`, export their bucket base name
  (`POD_STORE_NAME` / `RUN_SETTLEMENT_STORE_NAME`) so teardown/hydrate can address the same
  literal, and gain `reset()` in their state shape.
- **`lib/notification-prefs.ts`** (new) — `getPushEnabled(): Promise<boolean>` (missing row reads
  as enabled — opt-out) / `setPushEnabled(enabled): Promise<void>`, both via
  `GET`/`PATCH /users/me/preferences` under the `pushEnabled` key (same generic per-user
  preference store `locale` uses on web; the server-side `isPushEnabled` gate in
  `notifications.service.ts` is authoritative — see [`api.md`](api.md) — so a stale client can't
  re-enable delivery on its own). `app/(operator)/settings/index.tsx`'s push switch binds to it
  instead of local-only state; `lib/auth.ts` login registration and toggle-off deregistration both
  gate on it too (B04).
- **`components/ProductPickerSheet.tsx`** — new `activeOnly?: boolean` prop (default `false`,
  opt-in only); when set, the product query passes `isActive: true`. Stock-count/PO-receive/
  variant-parent callers keep the unfiltered query; only the driver-facing order-item add path
  opts in (web parity, B142) — the list itself stays unfiltered by `isActive` so a scan can still
  surface `· Archived` inline for a line already on the order.
- Registry: F19 (B111/B136/B137/B140/B150) and F20 (B04/B142, plus B151 already proven via #555)
  proved on #681/#682 and discharged to done in this follow-up; siblings B01/B02/B143 (F19, B143
  already done via #555) and B32/B23/B94/B95/B172 (F20) stay queued/untouched — out of scope
  for this wave.

### 2026-09-14 — hunt-mobile-scan lanes A, B, C, E (dedup, discard-guard, lazy catalogue, price-edit)

Five bug-fix lanes off `.claude/pipeline/2026-09-14-hunt-mobile-scan/plan.md`, landing as two PRs
(PR-1: lanes A/B/C/E, mobile-only; PR-2: lane D, stacked on PR-1, api + driver-durability — see
that PR's own bookkeeping commit for its entry). Lane A's lazy-load gate, `scan-accept-guard.ts`
and `scan-feedback-slot.ts` are documented above (tests-1.md / tests-2.md's scan-ladder.ts entry);
this section covers the rest of A/B/C/E.

- **Lane A — `edit-items.tsx` staged-edit durability.** New `lib/edit-items-draft.ts` (NEW, pure —
  no RN/AsyncStorage import; the screen owns every `getItem`/`setItem`/`removeItem`) is the pure
  half of the editor: `DraftItem`/`UnlistedDraft`/`StagedEdit` shapes; `orderOriginals(order)` +
  `stagedDiffItems(staged, originals)` (the ONE `buildOrderItemDiff` call both the dirty check and
  Save share) + `hasUnsavedItemEdits`/`hasUnsavedWork`; `shouldRehydrateFromOrder({hydrated, dirty,
justSaved})` (a background order refetch may re-`setDraft` from the server only on first
  hydration, right after a save, or onto an already-clean editor — an unconditional effect used to
  let ANY refetch silently discard staged work); the on-device snapshot
  (`EDIT_ITEMS_SNAPSHOT_VERSION`/`_TTL_MS`=24h/`_AUTOSAVE_DEBOUNCE_MS`=900,
  `snapshotBaseline(order)` as the staleness gate — NOT `order.updatedAt`, which bumps on
  order-level writes that don't invalidate a staged LINE edit —
  `make/serialize/deserializeEditItemsSnapshot`, `isSnapshotStale`); the keyspace
  `editItemsSnapshotKey(orderId, userId)` / `EDIT_ITEMS_SNAPSHOT_KEY_PREFIX =
"rf.edit-items.v1"` / `editItemsSnapshotUserPrefix(userId)` (one key PER ORDER — see
  `session-teardown.ts`'s new step (6) above); and the picker drawer's rows
  (`draftTrayRows` → `scan-tray.ts#trayRowsFrom`, `PICKER_TRAY_HANDLE_HEIGHT`=56,
  `pickerTrayExpandedHeight(win)`, floored to never cover `BarcodeScanner`'s viewfinder). The
  screen wires: a restore prompt (`restored`/`restoreChecked`/`restoreState` state reading
  `AsyncStorage.getItem(snapshotKey)` on mount), lazy-gated product search (`browsing` state +
  `useProductSearch({browsing})`, see tests-1.md), a `scanGuardRef` (`createScanAcceptGuard`,
  see above), and **`canEditPriceFor(productId) = orderPriceEditable && pricingReady &&
!isSpecialFor(productId)`** — `pricingReady` is in the AND deliberately: while the
  customer/customer-price queries are in flight `cpMap` is empty and `isSpecialFor` would
  answer false for a genuinely SPECIAL line (the exact window B62 was filed for). Specs:
  `__tests__/edit-items-draft.test.ts`, `__tests__/edit-items-drawer.test.ts`,
  `__tests__/picker-idle.test.ts`.

- **Lane B — scan-tray price edit + reducer-driven feedback.** `lib/scan-tray.ts#trayRowsFrom`
  gains `freeUnitsFor?: (id, line) => number` (threaded into `computeLineSubtotal`'s `freeUnits`
  so a BUY_N_GET_M tray row nets the same saving the footer does; default 0, existing callers
  unaffected). `components/ScanTray.tsx` gains `onEditPrice?: (id) => void` — when supplied, a
  row's subtotal renders as a tappable control (pencil icon) opening the caller's price editor;
  omitted, the row is plain text as before. `components/ScanOrderSheet.tsx` forwards it straight
  through (plus the `reduceScanSlot` rewrite documented above). `components/NewOrderScreen.tsx`
  (`ProductPickView`) adds **`onTrayEditPrice(id)`** (refuses with an inline toast — "Contract
  price — not editable on this order" — for a SPECIAL-tier catalog line, mirrors `edit-items.tsx`'s
  B263 lock) and a new **`LinePriceModal({open,name,unitPrice,onClose,onSave})`** (thin: collects
  a number via `MoneyTextInput`, `onSave(null)` clears the override back to catalog price;
  rounding/SPECIAL-lock/catalog-vs-unlisted stay with the caller) — the create surface's price
  editor used to live only inside CartModal, reachable by leaving scan mode; this is the
  create-side counterpart to the edit screen's existing one-tap edit. `app/(operator)/(tabs)/
invoices/new.tsx`'s `InvoiceComposer` gets the same `scanGuardRef`/`browsing` lazy-load wiring
  (see tests-1.md) plus a `productSearch: () => Array.from(productById.values())` local fast path
  (page 1 is no longer preloaded, so the ladder's local rung now reads every line already on the
  invoice, not just the current search page) and a `searchTermRef` (a native `onSubmitEditing`
  fired against a stale render — before `clearSearch()`'s re-render lands — now reads the ref, not
  render-scope `searchTerm`, so it can't resubmit a code that was just accepted).

- **Lane C — `FormSheet.tsx` discard confirmation + `lib/discard-guard.ts` (NEW, pure).**
  `FormSheetProps.warnIfDirty` renamed **`confirmDiscardIfDirty`**: unchanged web
  `beforeunload` behavior PLUS, on every platform, tapping header-X/footer-Cancel now routes
  through `lib/confirm.ts#confirm("Discard changes?", …, {destructive:true})` before actually
  leaving (`beforeunload` never fires for an in-app `router.back()`). Choke point: gated on
  FormSheet's OWN `submitting` prop via `shouldConfirmDiscard(dirty, submitting)`
  (`dirty && !submitting`), not just the caller's flag — so a caller that forgot to factor
  `submitting` into its own predicate still never prompts mid-submit. `discard-guard.ts` exports
  that generic gate plus per-screen dirty predicates, each named for its screen:
  `hasUnsavedStandingOrder({name,lines})` (`standing-orders/new.tsx`),
  `hasUnsavedInvoiceDraft({items,unlisted})` (`invoices/new.tsx`'s composer — the preceding
  CustomerPicker stage is deliberately unguarded, nothing to lose yet),
  `InvoiceEditLineSnapshot`/`InvoiceEditSnapshot` + `hasUnsavedInvoiceLineEdits(current,original)`
  (`invoices/[id]/edit.tsx` — compares every line + header field against the hydration-time
  snapshot; `original===null` never reads as dirty), `hasTouchedReceiveForm({qtys,boxQtys,
pieceQtys,notes})` (`purchase-orders/[id]/receive.tsx` — "touched" = present as an own key,
  not value-vs-seed, an accepted false-positive), `hasUnsavedPayment({amount,reference,notes,
bankCharges,paidAt,settledAt,photos,asDraft})` (`payments/record.tsx` — `allocs` excluded, a
  pure function of `amount`). Wired: `CustomerForm.tsx` (`shouldConfirmDiscard(isDirty,
submitting)`), `standing-orders/new.tsx`, `payments/record.tsx`, `purchase-orders/[id]/
receive.tsx`, `invoices/[id]/edit.tsx` (new `dirty` memo + `originalRef` snapshot taken in the
  hydration effect). `invoices/new.tsx`'s composer has no FormSheet, so it applies the same
  choke-point rule directly on its own back button (`handleBack` → `shouldConfirmDiscard(dirty,
saving)` → `confirm(...)`). Specs: `__tests__/discard-guard.test.ts`,
  `__tests__/form-guard-callers.test.ts`, `__tests__/edit-items-drawer.test.ts`.

- **Lane E — picker ergonomics.** `components/ProductPickerSheet.tsx` drops its `useAdminProducts`
  fetch-all (`limit:0`, a 10,000-row clamp + one presigned thumbnail URL per row) for
  `lib/use-product-search.ts#useAdminProductSearch` (see tests-1.md) — `browsing` state resets on
  close, an `idle` empty state offers "Browse catalogue", and infinite-scroll paging is wired via
  `onScroll`'s near-bottom check. A scanned variant's parent lookup (`standaloneOnly` mode) now
  fetches `GET /products/:parentProductId` directly via `apiClient` instead of a local `products
.find()` — the page rows are gated on a term/browse now, so a scanned variant would otherwise
  always miss that local search. `app/(operator)/recurring-invoices/new.tsx`'s
  `ProductPickerModal` gets the same `browsing`/`idle` lazy-load treatment (resets on `!open`).
  `packages/ui/src/mobile/ios/SearchBar.tsx` — `React.forwardRef<TextInput, SearchBarProps>` +
  new `autoFocus?: boolean` prop (default unfocused, unchanged); `invoices/new.tsx`'s search bar
  now passes `autoFocus`. `lib/api/products.ts useProductsInfinite` params gain `scanCode?`;
  `lib/api/admin.ts useAdminProducts`/`useAdminProductsInfinite` both gain a second
  `options?: {enabled?}` arg (mirrors `products.ts`, lets a picker gate its fetch while closed).

### 2026-09-14 — hunt-mobile-scan lane D (driver-durability, PR-2, stacked on PR-1)

- **`store/returnSubmissionStore.ts`** (new) — the 4th `skipHydration: true` user-scoped
  persisted store (joins podStore/runSettlementStore/stopCartStore), registered in both
  `session-teardown.ts` (step 4/5, `RETURN_SUBMISSION_STORE_NAME`) and `session-hydrate.ts`
  (`rehydrateUserScopedStores`) — see `mobile/tests-1.md`'s session-teardown entry for the
  9-store/4-persisted-blob count this pushed to. **F1 (independent review, PR-2, 2026-09-15)**
  added `nonces: Record<string,string>` + `getOrCreateNonce(key)` (key = `submittedReturnKey`'s
  own `stopId:orderId` convention) + `mintNonce()` (v4-shaped UUID, `Math.random`, mirrors
  `lib/order-submit-key.ts`'s `mintCartSessionKey`) — a per-ATTEMPT nonce baked into the
  Idempotency-Key so a retry of one pending attempt collapses server-side while a later,
  content-identical return does not (see below). `markSubmitted` clears the landed key's nonce;
  `reset()`/`partialize` cover `nonces` too.
- **`lib/return-submit-key.ts`** (new) + **`app/(driver)/route/stop/[stopId]/return/index.tsx`**
  — an offline-safe idempotency key for a driver's return submission, mirrored server-side by
  `common/idempotency.service.ts` on `POST /returns`'s `Idempotency-Key` header (api side: this
  file's `api/where-to-find.md` Returns row) — closes the double-submit-on-replay class this
  lane exists for (B307). **F1:** `returnSubmitKey(stopId, payload, nonce)` now takes the nonce
  from `returnSubmissionStore` as a REQUIRED 3rd argument (was stopId+payload alone, deterministic
  by content — which is exactly what silently collapsed a genuinely new later return for
  identical goods into an earlier landed one). The screen's `issue()` computes it per order via
  `getOrCreateNonce(submittedReturnKey(stopId, p.orderId))` before calling `mutateAsync`. Tests:
  mobile `__tests__/return-submit-key.test.ts` (`REG-RETURNS-IDEM-A..D`, base identity + wiring
  pins + nonce lifecycle + the end-to-end same/different-key claim).
- **B221/B353/B348** (api-side fixes riding in this same lane, no mobile code changes): driver
  return-list scoping, sequential return numbering via `NumberingService`, retired
  `ReturnStatus.PROCESSED` cleanup — full detail in `api/where-to-find.md`'s Returns row.
  `lib/returns-logic.ts`'s `returnPillFor`/`terminal` no longer special-case PROCESSED.
- Restored `apps/mobile/lib/api/orders.ts`, `lib/offline-errors.ts`, `hooks/useSocket.ts`,
  `lib/query-client.ts`, `app/(driver)/route/stop/[stopId]/payment.tsx` alongside — pre-existing
  files this lane's original (orphaned) patch touched; no NEW capability beyond what their own
  diffs already carry (see PR-2's own body once opened).
