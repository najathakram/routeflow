## 8. Operator — Routes, Route Runs, Exceptions, Settings

**Role(s):** Operator (tenant admin / dispatcher) • **Entered via:** Bottom-tab **More** menu → "Routes", "Exceptions", "Settings", "Profile"; live route runs are opened as **deep links** from the Route detail (after dispatch), the **Home** tab (active run banner), and the **Dispatch** tab (run rows). Everything sits under the `(operator)` stack (no tab of its own).

This area is the operator's dispatch back-office: building reusable route templates (ordered customer stops), assigning drivers, optimizing stop order, dispatching a template into a dated **route run**, then live-monitoring that run's progress on a map, reviewing the aggregated packing list, triaging cross-app exceptions (urgent orders / late routes / pending returns), and managing tenant settings, users, and the operator's own profile/password. The whole stack is tenant-scoped; a persistent offline banner (with a queued-action count) sits above every screen via the `(operator)` layout.

### Screens

#### Routes (templates list) — `/(operator)/routes`

- **File:** `apps/mobile/app/(operator)/routes/index.tsx`
- **Purpose:** List all route templates for the tenant with driver-assignment status at a glance.
- **Shows:** Large title "Routes" with subtitle `{n} template(s)`; per-row card: route `name`, sub-line `{driverName} · {stopCount} stop(s)` (driver name resolved from `useAdminDrivers` by `driverId`, else "Unassigned"), and a status **Pill** — gray "Inactive" (when `isActive === false`), green dotted "Assigned" (has `driverId`), or red "No driver". Stop count from `r._count.stops`.
- **Actions:** "Add" nav action (top-right) and empty-state "Create route" button → `/(operator)/routes/new`; row tap → `/(operator)/routes/{id}`; "Back" → `router.back()`. Data via `useAdminRoutes({ limit: 100 })` (GET `/routes`) and `useAdminDrivers()` (GET `/drivers`).
- **States:** loading spinner; empty ("No routes yet." + Create route CTA); pull-to-refresh (`RefreshControl` on `isFetching && !isLoading`).

#### New route — `/(operator)/routes/new`

- **File:** `apps/mobile/app/(operator)/routes/new.tsx`
- **Purpose:** Create a bare route template (name + optional description); stops are added afterward on the detail screen.
- **Shows:** `FormSheet` titled "New route" with a "Details" section — **Name** (required, `autoCapitalize="words"`, placeholder "Route A — Downtown") and **Description** (optional multiline, 3 lines).
- **Actions:** "Create" (label flips to "Saving…") → `useCreateRoute` → POST `/routes`; on success toast "Route created" and `router.replace('/(operator)/routes/{newId}')`. Close (X) / Cancel → `router.back()`.
- **States:** inline validation error "Name is required." under the Name field; submitting (spinner in footer button); error toast from API message.

#### Create route (alias) — `/(operator)/routes/create`

- **File:** `apps/mobile/app/(operator)/routes/create.tsx`
- **Purpose:** RF-203 route-alias shim — re-exports the New Route screen (`export { default } from "./new"`). Exists so a `/routes/create` URL (shared link / browser back-forward on Expo web) renders the form immediately instead of falling through to `[id]`, which would treat "create" as a route ID, fire a 404 lookup, and spin forever.
- **Shows / Actions / States:** identical to **New route**.

#### Route detail — `/(operator)/routes/{id}`

- **File:** `apps/mobile/app/(operator)/routes/[id].tsx`
- **Purpose:** The template's control center — view/edit stops, assign a driver, optimize, and dispatch a run.
- **Shows:** Header card: route `name` + gray "Inactive" pill when inactive, plus `description`. **Driver** card: driver display name + vehicle line (`vehicleMake vehicleModel · vehiclePlate`) or "Not assigned". **Stops ({n})** card: numbered badge + `customer.businessName` (falls back to `customerId`); an orange "No location" flag with alert icon when the stop's `customerAddress.lat/lng` is missing.
- **Actions:**
  - "Edit" (top-right) → `/(operator)/routes/{id}/edit`.
  - Driver card "Change"/"Assign" → `/(operator)/routes/{id}/assign-driver`.
  - Stops card "Add" → `/(operator)/routes/{id}/add-stop`.
  - **Reorder stops:** native uses a `DraggableFlatList` (long-press the reorder handle to drag) → `useReorderRouteStops` → PATCH `/routes/{id}/stops/reorder` with `{ order: [{id, stopNumber}] }`. On **web** the drag list is replaced by up/down chevron buttons doing the same reorder mutation.
  - Trash icon per stop → confirm "Remove stop?" (destructive) → optimistic removal + `useRemoveRouteStop` → DELETE `/routes/{id}/stops/{stopId}`; rolls back on error.
  - "View on map" → `/(operator)/routes/{id}/map`.
  - "Optimize stops" (sparkles) → `useOptimizeTemplate` → POST `/routes/{id}/optimize`; toast "Route optimized" or "Reordered (distance-based fallback)" if `usedFallback`. Disabled with < 2 stops.
  - "Dispatch run" → opens a bottom-sheet **Modal** (Date field defaulting to local today `YYYY-MM-DD`, optional Notes) → `useCreateRun` → POST `/route-runs` `{ routeId, scheduledDate, notes }`; on success toast "Run created" and pushes `/(operator)/route-runs/{runId}`.
  - "Delete route" → confirm "Delete route?" (destructive) → `useDeleteRoute` → DELETE `/routes/{id}` → `router.back()`.
  - Data: `useAdminRoute(id)` (GET `/routes/{id}`) with `useFocusEffect` refetch on focus.
- **States:** loading spinner (inline "Route" navbar); empty stops ("No stops yet."); dispatch button **gated** — disabled + hint "Assign a driver before dispatching" (no driver) or "Add at least one stop before dispatching" (0 stops); per-mutation pending opacity/spinners. Defensive redirect: `id === "create"|"new"` → `router.replace('/(operator)/routes/new')`.
- **Steps (dispatch):** 1) tap "Dispatch run" → 2) modal: set/confirm date + notes → 3) "Dispatch" (POST `/route-runs`) → 4) navigate to the live run screen.

#### Edit route — `/(operator)/routes/{id}/edit`

- **File:** `apps/mobile/app/(operator)/routes/[id]/edit.tsx`
- **Purpose:** Rename/redescribe a template and toggle active status.
- **Shows:** `FormSheet` "Edit route" pre-filled from `useAdminRoute(id)` — **Name**, **Description** (multiline), and an **Active** switch with hint "Inactive routes are hidden from dispatch."
- **Actions:** "Save" (→ "Saving…") → `useUpdateRoute` → PATCH `/routes/{id}` `{ name, description, isActive }`; success toast "Saved" + `router.back()`. Cancel/X → back.
- **States:** loading spinner until route resolves; inline toast "Name is required." if blank; error toast from API.

#### Assign driver — `/(operator)/routes/{id}/assign-driver`

- **File:** `apps/mobile/app/(operator)/routes/[id]/assign-driver.tsx`
- **Purpose:** Pick (or unassign) the driver for this template.
- **Shows:** List of **ACTIVE** drivers (`useAdminDrivers({ status: "ACTIVE" })`) — avatar initials, name (`firstName lastName` → `username`), vehicle sub-line; current driver row is brand-outlined with a checkmark. If a driver is already assigned, a top "Unassign driver" row (red close icon, "Remove the current driver from this route.").
- **Actions:** tap a driver → `useUpdateRoute` → PATCH `/routes/{id}` `{ driverId }` → toast "Driver assigned" + back; "Unassign" → PATCH with `driverId: null` → toast "Driver removed" + back.
- **States:** loading spinner; empty "No active drivers."; rows disabled while mutation pending.

#### Add stop — `/(operator)/routes/{id}/add-stop`

- **File:** `apps/mobile/app/(operator)/routes/[id]/add-stop.tsx`
- **Purpose:** Search customers and append one as a route stop.
- **Shows:** iOS `SearchBar` ("Search customers…") over a customer list (`useAdminCustomers({ search, limit: 100 })`) — `businessName` + `contactName`, each with an add-circle icon.
- **Actions:** tap a customer → `useAddRouteStop` → POST `/routes/{id}/stops` `{ customerId }` → toast "Stop added" + back; "Cancel" (nav back button) → back.
- **States:** loading spinner; empty "No customers found."; rows disabled while pending.

#### Route map (template) — `/(operator)/routes/{id}/map`

- **File:** `apps/mobile/app/(operator)/routes/[id]/map.tsx`
- **Purpose:** Plot the template's geocoded stops (and the depot) on a map with the route polyline.
- **Shows:** `AppMapView` with brand-colored numbered pins `"{stopNumber}. {businessName}"`; a green **Depot** pin when `useRouteSettings` returns `depotLat/depotLng` (GET `/settings/route`), with `depotAddress` subtitle; a route polyline connecting plottable stops when ≥ 2 exist; an orange banner "{n} stops not shown — missing geocoded address" when some stops lack coords.
- **Actions:** "Back" → `router.back()`. `useFocusEffect` refetch on focus. (Read-only view — no stop mutations here.)
- **States:** loading spinner; full empty state (location-outline icon + "None of the stops on this route have geocoded addresses yet. Add lat/lng on each customer to see them on the map.") when nothing is plottable.

#### Route run (live monitor) — `/(operator)/route-runs/{id}`

- **File:** `apps/mobile/app/(operator)/route-runs/[id].tsx`
- **Purpose:** Operator's live view of a dispatched run — map, progress KPIs, per-stop status, and run-level controls (optimize, navigate, skip/reopen, cancel).
- **Shows:** Top **map** (260px) with status-colored pins (`statusToPinColor` per stop status), depot pin, route polyline (≥2 pins), and the "{n} stops not shown" banner. Summary card: run's route `name` + status **Pill** ("Scheduled"/"In progress"/"Completed"/"Cancelled"), sub-line `{driver.contactName ?? "Unassigned"} · {completed}/{total} stops`, a progress bar (`completed/total`), a 4-up stat row **Done / Pending / Skipped / Progress%**, and a "Now: …"/"Next: …" current-stop chip (in-progress stop, else first pending). **Stops** card: numbered badge tinted by status (green completed / orange in-progress / gray skipped), `businessName`, humanized status text, and an orange "no location" flag when coords missing.
- **Actions:**
  - "Packing list" → `/(operator)/route-runs/{id}/packing-list`.
  - "Open in Google Maps" (non-terminal) → `handleOpenInMaps`: filters PENDING/IN_PROGRESS stops, reads current GPS if run is IN_PROGRESS (`expo-location` foreground permission; web uses `navigator.geolocation`), then `openRouteInMaps` builds a multi-stop Google Maps `dir` URL. A second "Open in Google Maps" (navigate icon) appears when `pins.length > 0`.
  - "Optimize run" / "Re-optimize from here" (when status SCHEDULED or IN_PROGRESS) → `useOptimizeRouteRun` → POST `/route-runs/{id}/optimize`; if IN_PROGRESS it passes current GPS `{ originLat, originLng }`. Toast "Run optimized" / "Reordered (fallback)". Requires ≥ 2 stops.
  - Per-stop: COMPLETED stops show a **reopen** (refresh) button → confirm "Reopen stop?" → `useReopenStop` → POST `/route-runs/{id}/stops/{stopId}/reopen`; PENDING/IN_PROGRESS stops show a **skip** (×) button → confirm "Skip stop?" (destructive) → `useUpdateStopStatus` → PATCH `/route-runs/{id}/stops/{stopId}` `{ status: "SKIPPED" }`.
  - "Cancel run" (non-terminal, red) → confirm "Cancel run?" (destructive, "Drivers can no longer check in or complete stops.") → `useUpdateRunStatus` → PATCH `/route-runs/{id}/status` `{ status: "CANCELLED" }`.
  - Data: `useRouteRun(id)` (GET `/route-runs/{id}`) + `useRouteSettings`; `useFocusEffect` refetch on focus.
- **States:** loading spinner; map-empty fallback (120px "No geocoded stops to show on the map."); empty stops ("No stops on this run."); **terminal read-only** — when status is COMPLETED/CANCELLED, the map-navigate, optimize, and cancel controls are hidden (packing list stays). Optimize/cancel show inline spinners while pending.

#### Packing list — `/(operator)/route-runs/{id}/packing-list`

- **File:** `apps/mobile/app/(operator)/route-runs/[id]/packing-list.tsx`
- **Purpose:** Aggregated load-out sheet — total quantity per product across the run's orders, broken down by customer.
- **Shows:** Per-product card: `productName`, `SKU: {sku}` (when present), a brand total badge `{totalQty} {unit}`, and a per-customer breakdown list `{name}` → `{qty} {unit}`. Data via `usePackingList(id)` (GET `/route-runs/{id}/packing-list`, tolerates both array and `{ packingList }` response shapes).
- **Actions:** "Run" back button → `router.back()`. (Read-only.)
- **States:** loading spinner; empty ("No items on this run.").

#### Exceptions — `/(operator)/exceptions`

- **File:** `apps/mobile/app/(operator)/exceptions.tsx`
- **Purpose:** Single triage feed merging three cross-app problems needing operator attention.
- **Shows:** Large title "Exceptions" / inline "Needs attention", an uppercase count row "{n} exception(s)", then severity-sorted cards (urgent → warning → info). Card types:
  - **Urgent order** (red "Urgent", flash icon): `Urgent order {orderNumber}` / `{businessName} · needs immediate attention` — from `useAdminOrders({ urgent: true, status: "PENDING", limit: 20 })`.
  - **Late route** (orange "Warning", time icon): IN_PROGRESS runs whose `scheduledDate` is before local today — `Late route — {routeName}` / `{stopsLeft} stop(s) remaining · driver: {contactName}` — from `useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 })`.
  - **Pending return** (brand "Pending", return icon): `Return awaiting approval` / `{businessName} · {returnNumber} · {reason}` — from `useAdminReturns({ status: "PENDING", limit: 20 })`.
  - Each card has an action footer ("View order" / "View run" / "Review" + chevron).
- **Actions:** card tap → `router.push(actionRoute)` — urgent order → `/(operator)/orders/{id}`; late route → `/(operator)/routes` (list, **not** the specific run); pending return → `/(operator)/returns`. "More" back button → `router.back()`.
- **States:** loading spinner (any of the three queries loading); "All clear" `IosEmptyState` (green check) when zero exceptions; pull-to-refresh refetching all three queries in parallel.

#### Settings — `/(operator)/settings`

- **File:** `apps/mobile/app/(operator)/settings/index.tsx`
- **Purpose:** Tenant business settings across four in-screen tabs (chip strip): **General | Users | Branding | Integrations** (RF-090 + RF-213).
- **Shows / Actions per tab:**
  - **General** (`useBusinessSettings` → save via `useUpdateBusinessSettings`): identity card (`businessName`, `email`); **Contact** → Phone; **Address** → City, ZIP; **Invoicing** → "Default tax rate (e.g. 0.0875)" (decimal, sent as `Number`); **Notifications** → a "Push notifications" switch that only fires a local `alertInfo` ("We'll register this device… on your next launch." / "Notifications won't be delivered…") — **not persisted** to the settings mutation. "Save changes" (→ "Saving…") persists phone/city/zip/taxRate; toast "Settings saved".
  - **Users** (RF-090; `useAdminUsers`): per-user row with display name, **role pill** (brand "Operator" / green "Driver" / orange "Buyer" / gray other), gray "Inactive" pill, and `@username · email`. "Deactivate"/"Activate" button → `useToggleUserStatus` → toast "User deactivated"/"User activated" + refetch.
  - **Branding** (RF-213): info card explaining logo + brand colours are configured in the **web portal**; a "Coming soon on mobile" list (Logo upload, Brand colour picker, Invoice header/footer). No mutations.
  - **Integrations** (RF-213): info card ("configured in the web dashboard"); static list — Xero, QuickBooks, Stripe, Shopify, Google Maps API, Twilio SMS — each with a "Coming soon" badge. No actions.
- **States:** per-tab loading spinner (General/Users); Users empty "No users found."; toggle buttons disabled while pending; Branding/Integrations are static informational (mobile is read-only, web is the source of truth).

#### Profile — `/(operator)/profile`

- **File:** `apps/mobile/app/(operator)/profile.tsx`
- **Purpose:** Operator's own account summary + sign-out and password entry point.
- **Shows:** Avatar (initials from `user.username`), display name, `Operator · {tenantName}` (tenant from `useTenantStore().branding.businessName`); **ACCOUNT** group (Username, Role); **SETTINGS** group ("Change password" row with chevron); a red "Sign out" row; footer "RouteFlow v1.0.0".
- **Actions:** "Change password" → `/(operator)/change-password`; "Sign out" → `useAuthStore().logout()`; "More" back → `router.back()`.
- **States:** static (reads from auth/tenant stores) — no loading/empty/error states.

#### Change password — `/(operator)/change-password`

- **File:** `apps/mobile/app/(operator)/change-password.tsx`
- **Purpose:** Change the signed-in operator's password.
- **Shows:** Three secure `MobileInput`s — Current Password, New Password, Confirm New Password — via react-hook-form + zod. Green success banner ("Password updated successfully!") and centered API-error text.
- **Actions:** "Update Password" (loading state) → `changePassword(currentPassword, newPassword)` (`lib/auth`); on success resets the form, shows the banner, and after ~1.8s `router.back()`. "Back" → back.
- **States:** per-field zod errors (new password min 8 + must contain an uppercase letter + a number; confirm must match); submitting (button loading); API error surfaced from `err.response.data.message`; transient success banner.
- **Steps:** 1) enter current → 2) enter + confirm new (validated) → 3) submit (calls change-password) → 4) success banner → auto-navigate back.

### Key flows (end-to-end journeys through this area)

- **Build & dispatch a route:** More → Routes (`/routes`) → "Add" → New route (POST `/routes`) → Route detail → "Add" stops (POST `/routes/{id}/stops`, repeat) → drag/chevron reorder (PATCH `…/stops/reorder`) or "Optimize stops" (POST `/routes/{id}/optimize`) → "Assign"/"Change" driver (PATCH `/routes/{id}` `{driverId}`) → "Dispatch run" modal (POST `/route-runs`) → lands on the live **route run**.
- **Optimize before dispatch vs. re-optimize live:** Template optimize (POST `/routes/{id}/optimize`, no origin) reorders the template; on an IN_PROGRESS run, "Re-optimize from here" reads the operator's GPS and POSTs `/route-runs/{id}/optimize` with `{originLat, originLng}` so remaining stops re-sequence from the current position.
- **Live run monitoring & recovery:** Home active-run banner / Dispatch row / post-dispatch → Route run `/route-runs/{id}` → watch progress bar + stat row → "Open in Google Maps" (GPS-anchored multi-stop directions) → skip a blocked stop (PATCH status SKIPPED) or reopen a mis-completed one (POST `…/reopen`) → optionally "Cancel run" (PATCH status CANCELLED). "Packing list" gives the load-out totals per product/customer.
- **Exception triage:** More → Exceptions → merged urgent-orders / late-routes / pending-returns feed → tap a card → jump to Orders detail, Routes list, or Returns to resolve.
- **Account maintenance:** More → Profile → Change password (validated, calls change-password, auto-returns) or Sign out; More → Settings → General (save contact/tax) / Users (activate-deactivate).

### Use cases

- As an **operator**, I want to assemble an ordered list of customer stops into a reusable route template so that I can dispatch the same route repeatedly. (path: `/routes` → `/routes/new` → `/routes/{id}` → `/routes/{id}/add-stop`)
- As an **operator**, I want the app to auto-order stops for the shortest path so that drivers don't drive back and forth. (path: `/routes/{id}` "Optimize stops"; or `/route-runs/{id}` "Optimize/Re-optimize")
- As a **dispatcher**, I want to assign the right active driver (with vehicle info) to a route before it goes out. (path: `/routes/{id}` → `/routes/{id}/assign-driver`)
- As an **operator**, I want to turn a template into a dated run and immediately watch it live on a map so I can see progress and the driver's next stop. (path: `/routes/{id}` dispatch modal → `/route-runs/{id}`)
- As an **operator**, I want to skip a stop the driver can't reach or reopen one that was completed by mistake, without editing the whole run. (path: `/route-runs/{id}` per-stop skip/reopen)
- As a **warehouse operator**, I want a consolidated packing list per product with a customer breakdown so I can stage the truck load. (path: `/route-runs/{id}` → `/route-runs/{id}/packing-list`)
- As an **operator**, I want one screen that surfaces urgent orders, overdue routes, and returns awaiting approval so nothing slips. (path: `/exceptions`)
- As a **tenant admin**, I want to update business contact/tax settings and activate/deactivate users from my phone. (path: `/settings`)
- As an **operator**, I want to change my password or sign out on the go. (path: `/profile` → `/change-password`)

### Business rules & edge cases

- **Dispatch gating:** "Dispatch run" is disabled unless the template has **both** an assigned driver and ≥ 1 stop; the button shows the specific blocking hint.
- **Optimize gating:** both template and run optimization require **≥ 2 stops**; otherwise a toast ("Add at least two stops first." / "Need at least two stops."). Optimization can silently fall back to a distance-based order (`usedFallback` → "Reordered (fallback)").
- **Local-date discipline (BUG-W-8):** the dispatch date defaults to the operator's **local** calendar day via `localTodayISO()` (not `toISOString()` UTC), so an evening dispatch doesn't schedule the run a day ahead.
- **Run terminal read-only:** once a run is COMPLETED or CANCELLED, the operator loses navigate/optimize/cancel controls; only the packing list remains. Optimize is only offered for SCHEDULED or IN_PROGRESS.
- **Stop status set:** stops move PENDING → IN_PROGRESS → COMPLETED, or SKIPPED; the operator can only **skip** PENDING/IN_PROGRESS stops and only **reopen** COMPLETED stops. "Now/Next" is the in-progress stop, else the first pending.
- **GPS-anchored optimization/navigation:** current location is read (native `expo-location` foreground permission; web `navigator.geolocation`) **only** when the run is IN_PROGRESS; if permission is denied it falls back to the first stop as origin.
- **Missing geocode handling:** stops without `customerAddress.lat/lng` are flagged ("No location"), excluded from map pins and the polyline, and counted in the "{n} stops not shown" banner; a template/run with zero geocoded stops shows a full empty map state.
- **Web vs native reordering:** native uses drag-to-reorder (`DraggableFlatList`, long-press handle); web substitutes up/down chevrons — both hit PATCH `/routes/{id}/stops/reorder`. Stop removal is optimistic with rollback on failure.
- **Route-alias 404 guard (RF-203):** `/routes/create` re-exports the New form and `[id]` defensively redirects `id === "create"|"new"` to `/routes/new`, preventing an infinite spinner from a doomed lookup.
- **Packing-list response tolerance:** `usePackingList` accepts either a raw array or `{ packingList }` shape; the screen guards `item.unit`/`item.sku`/`item.customers` as optional.
- **Push toggle is cosmetic:** the Settings "Push notifications" switch only shows a local alert and does **not** persist through the business-settings mutation (which saves phone/city/zip/taxRate).
- **Branding/Integrations are web-owned:** those tabs are read-only informational on mobile — logo, brand colour, and third-party connections are configured in the web dashboard (mobile mirrors, doesn't own).
- **Offline awareness:** the `(operator)` layout renders a persistent offline banner with a queued-action count (`useNetworkSync`) and hoists the Socket.IO subscription (`useSocket`) so route/stop/order real-time events keep queries fresh across all these screens (RF-002).
- **Multi-tenant scoping:** all data (routes, drivers, customers, runs, users, settings) is tenant-scoped; profile shows the tenant business name alongside the operator role.
- **Password policy:** new password must be ≥ 8 chars and contain an uppercase letter and a number, and match the confirmation (zod-enforced client-side before calling change-password).

Files (all absolute):

- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\index.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\new.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\create.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\[id].tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\[id]\edit.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\[id]\assign-driver.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\[id]\add-stop.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\routes\[id]\map.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\route-runs\[id].tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\route-runs\[id]\packing-list.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\exceptions.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\settings\index.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\profile.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\change-password.tsx`
- Shared: `C:\ClaudeCode\routeflow\apps\mobile\components\FormSheet.tsx`, `C:\ClaudeCode\routeflow\apps\mobile\components\openInMaps.ts`, `C:\ClaudeCode\routeflow\apps\mobile\lib\api\routes.ts`, `C:\ClaudeCode\routeflow\apps\mobile\lib\api\admin.ts`
