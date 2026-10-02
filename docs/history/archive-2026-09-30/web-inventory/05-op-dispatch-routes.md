# 05 — Operator: Dispatch & Routes

**Role(s):** Operator / Tenant Admin (`OPERATOR`, `TENANT_ADMIN`). Some operator-only controls (reorder,
optimize, cancel, delete, change-driver) are additionally gated on `user.role === "OPERATOR"` in the
run/dispatch screens. A "My Routes" self-view is gated on `canActAsDriver`. • **Entered via:** the
dashboard left sidebar — **Dispatch** and **Routes** — plus deep links from the Orders area and the
`/dashboard` overview. Run/dispatch/template pages are reached by drilling into a card or table row.

This is the operator's dispatch back-office in **web**. It mirrors the mobile operator flow
([`../mobile-inventory/08-op-routes.md`](../mobile-inventory/08-op-routes.md)) but with a desktop
**map-beside-list split** on every builder/detail screen, drag-and-drop reordering (`@dnd-kit`),
browser **print** manifests, and no GPS/offline layer. Two nouns are distinct and easy to confuse:

- **Route template** (`Route`) — a reusable, ordered list of customer **stops** with an optional
  default driver and depot. Lives at `/routes/templates/[id]`. Statuses: `isActive` **Active / Inactive** only.
- **Route run** (`RouteRun`) — a dated dispatch of a template that drivers actually execute. Lives at
  `/routes/[id]` (detail) and `/routes/[id]/dispatch` (live dispatch + manifest). Statuses:
  **SCHEDULED → IN_PROGRESS → COMPLETED**, or **CANCELLED**.

> ⚠️ **Documented from source, contra the brief.** The routes list does **not** use a
> DRAFT/PLANNED status model, distance metrics, "duplicate" action, or saved views — none exist in
> the code. Route **templates** carry only `isActive`; the DRAFT/PLANNED/IN_PROGRESS/COMPLETED/CANCELLED
> machine belongs to **runs** (and `DRAFT`/`PLANNED` are not among the four run statuses either — see
> the state machine at the end). This doc records what ships.

---

## Screens

### Dispatch overview — `/dispatch`

- **File:** `apps/web/app/(dashboard)/dispatch/page.tsx`
- **Purpose:** Single at-a-glance operations board — what's running now, what's scheduled today, and
  each driver's load for the day.
- **Shows:** `PageHeader` "Dispatch" / "Today's runs and driver status across the operation." Three
  cards (`CardShell`):
  - **Active Now** — grid of cards for **all active runs** (`useRouteRuns({ activeOnly: true, limit: 100 })`,
    **polls every 30 s**). Each: `route.name`, `driver.contactName ?? "Unassigned"`, a status `Badge`,
    `{done} / {total} completed` (done = stops `COMPLETED` **or** `SKIPPED`), an elapsed-time chip
    (`elapsedSince(startedAt)` → "just now"/"Nm"/"Nh Nm"/"Nd"), and an **Open dispatch** link →
    `/routes/{run.id}/dispatch`.
  - **Today's Schedule** — list of runs whose `scheduledDate` is **local today**
    (`useRouteRuns({ date: todayLocalISO(), limit: 100 })`). Each row: route name, driver name **or**
    a warning **Unassigned** badge, a start-time chip (`startTime` or `startedAt`), status badge; row
    click → `/routes/{run.id}` (run detail).
  - **Drivers** — every driver (`useDrivers({ limit: 100 })`) with today's run count derived from the
    today list (`"No runs today"` / `"N run(s) today"`), a status `Badge`; row click → `/drivers/{id}`.
- **Actions:** Open dispatch (→ live dispatch); open a scheduled run; open a driver profile.
- **States:** per-card skeleton pulse (loading); inline red "Failed to load data. Please try
  refreshing." (error); empty copy per card — "No active runs right now.", "Nothing scheduled today.",
  "No drivers yet."

### Routes list — `/routes`

- **File:** `apps/web/app/(dashboard)/routes/page.tsx`
- **Purpose:** The routes home — manage **active runs** (any date) at the top and the library of
  **route templates** below.
- **Shows:**
  - `PageHeader` "Routes" with a **Select** / **Cancel** toggle (bulk mode) and a **New Route** button
    (→ `/routes/create`).
  - **Active Runs** section — cards for `useRouteRuns({ activeOnly: true, limit: 100 })` (SCHEDULED +
    IN_PROGRESS, **any date** — intentionally not date-filtered so orphan active runs from prior days
    are visible and cancelable; otherwise the API's duplicate-active-run guard blocks re-dispatch with
    no way to find the blocker). Each card: route name, driver name, status `Badge`, a **ProgressBar**
    (`{done} of {total} stops · {pct}%`), and a metadata line (Scheduled Today/date · Started {time} ·
    Finished {time}).
  - **Route Templates** section — a `Table` (`useRoutes()`) with columns **Route Name**, **Stops**
    (`_count.stops`), **Created** (date), and a per-row actions cell. RF-206 dedupes rows by route ID.
    Empty state: `EmptyState variant="routes"` "No route templates yet".
- **Actions:**
  - Active-run card: **View** (→ `/routes/{id}` run detail); **Edit** (`EditRunModal` — change driver/date/notes;
    shown when not COMPLETED/CANCELLED); **Cancel** (confirm modal → `useUpdateRouteRunStatus` `{status:"CANCELLED"}`;
    SCHEDULED or IN_PROGRESS); **Delete** (confirm modal → `useDeleteRouteRun`; SCHEDULED only).
  - Template row: **View template** (eye → `/routes/templates/{id}`); **Dispatch run** (play → opens
    `DispatchModal` inline).
  - `DispatchModal`: **Scheduled Date** (defaults to `new Date().toISOString()` today — see edge cases),
    **Driver (optional)** select of ACTIVE drivers → **Dispatch** → `useCreateRouteRun` → toast + push
    `/routes/{newRunId}`.
  - **Bulk delete:** Select mode adds row checkboxes + "Select all"; a danger action bar deletes the
    selected templates in parallel (`deleteRoute.mutateAsync`), toast "N routes deleted".
- **States:** section skeletons (loading); inline red error banners; "No active runs. Dispatch a
  template below to start one." / template empty state; per-mutation loading spinners; confirm modals
  for cancel/delete (both "cannot be undone").

### Route builder (create) — `/routes/create`

- **File:** `apps/web/app/(dashboard)/routes/create/page.tsx` (+ `CreateRouteLeftPanel.tsx`,
  `CreateRouteMap.tsx`)
- **Purpose:** Build a new **template** on a single map-beside-form screen — pick customer stops,
  optionally optimize their order, name it, assign a default driver, and save (which creates the route
  then appends each stop).
- **Shows:** A top bar (**← Routes** / "Create Route") over a **40% left panel + 60% Google Map**
  split. Left panel: **Route Name** (required) + **Default Driver** select; a **Stops (N)** header;
  an **Optimize Stop Order** button (only when ≥ 2 stops have geocoded coords); a customer
  search-with-dropdown (debounced 300 ms; each result shows business/contact name and "Also in:
  {routeNames}" when the customer is already on other routes; disabled + "Added" when already picked);
  a scrollable ordered stop list (grip handle, number badge, name, address, an amber ⚠ "No GPS
  coordinates" flag, remove ✕); a sticky **Cancel / Create Route** bar. The map plots customer pins
  (grey unselected, blue selected/numbered), a depot **Home** pin from route settings, and lets you
  click a pin to add/remove that stop.
- **Actions:** add stop (search dropdown **or** map pin click) → local state; remove stop; **Optimize**
  (client-side nearest-neighbour + 2-opt, depot-anchored when a depot exists — no server call);
  **Create Route** → `useCreateRoute` (POST `/routes` with name/driverId/depot) then **sequential**
  POST `/routes/{id}/stops` per stop (stopNumber = index+1), then invalidate `routes` +
  `customer-route-assignments`, toast "Route created", push `/routes`.
- **States:** zod inline error "Route name is required"; empty stop list ("Click pins on the map or
  search above to add stops."); submitting ("Creating…", button disabled).
- **Steps (numbered wizard — implemented as one screen, not a paged flow):**
  1. **Name + default driver** — enter Route Name (required); optionally pick a Default Driver.
  2. **Pick stops** — search customers (or click map pins) to append stops; duplicates blocked;
     cross-route membership surfaced inline.
  3. **Optimize (optional)** — with ≥ 2 geocoded stops, click **Optimize Stop Order** to reorder
     client-side (NN + 2-opt, depot-anchored if a depot is set).
  4. **Save** — **Create Route**: creates the template, then appends every stop in order, then returns
     to `/routes`. (Dispatch is a separate later step from the template detail — this wizard **builds**,
     it does not dispatch.)

### Route run detail — `/routes/[id]`

- **File:** `apps/web/app/(dashboard)/routes/[id]/page.tsx` (+ `RouteMap.tsx`)
- **Purpose:** The **run's** control center — review/reorder stops, watch progress, optimize, edit,
  cancel/delete, and jump to the live dispatch panel. (This is a **run** detail, not a template detail.)
- **Shows:** Top bar: **← Routes**, route name, status `Badge`, driver name, "Started {time}",
  `{done}/{total} stops`, and a control cluster. Below: a **40% stop list + 60% map** split. Each
  `StopItem`: status icon (✓ COMPLETED / spinner IN_PROGRESS / ✕ SKIPPED / ○ PENDING), `#stopNumber`,
  business name, a **CURRENT** pill on the in-progress stop, address line, "Completed {time}"; expands
  to show that stop's **Orders** (order # + status) and any **Driver note** (warning-styled). The map
  (`RouteMap`) plots the run's stops.
- **Actions (all operator-gated, status-gated):**
  - **Drag-to-reorder** stops — only when `isOperator && status === "SCHEDULED"`; optimistic local
    reorder → `useReorderRunStops` (PATCH `/route-runs/{id}/stops/reorder`); rolls back + toast on error.
  - **Edit** (`EditRunModal`) — when not COMPLETED/CANCELLED.
  - **Cancel Run** — when IN_PROGRESS or SCHEDULED (and not deletable); confirm modal →
    `useUpdateRouteRunStatus {status:"CANCELLED"}` → push `/routes`.
  - **Delete** — SCHEDULED only; confirm modal → `useDeleteRouteRun` → push `/routes`.
  - **Optimize** — when not COMPLETED/CANCELLED; `useOptimizeRoute` (POST `/route-runs/{id}/optimize`);
    toast "Route reordered" or, on `usedFallback`, "Route reordered (fallback)" with a reason-specific
    hint (ORS not configured / rate-limited / HTTP / network).
  - **Dispatch Panel** — always → `/routes/{id}/dispatch`.
- **States:** full-screen spinner (loading); "Route run not found." + Back button (error); stop list
  renders draggable vs static depending on `canReorder`; per-action spinners.

### Live dispatch + manifest — `/routes/[id]/dispatch`

- **File:** `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx`
- **Purpose:** The pre-departure / in-flight dispatch console for a run — a **Must Stop / Optional
  Stops** checklist on the left and a **Loading Manifest** (aggregated pack list) on the right, built
  to be **printed** and handed to the warehouse/driver. This is the web analogue of the mobile
  packing-list + run-monitor.
- **Shows:** Sticky top bar (**← Route Detail**, route name, status `Badge`, full scheduled date,
  driver name). **Left (45%)** — **Must Stop (N — customers with orders)**: brand-tinted
  `RequiredStopCard`s (numbered badge, business name, address, "{n} orders" pill, "{items} items to
  deliver", a delivery-window chip when `deliveryWindowStart/End` set; expands to per-order line items
  ×qty). **Optional Stops (N — no current orders)**: muted `OptionalStopCard`s with "Stop at your
  discretion." **Right (flex)** — **Loading Manifest** table (`useRunPackingList` → GET
  `/route-runs/{id}/packing-list`): **Product · SKU · Total Qty · Customers** (per-customer ×qty chips),
  a footer total row (sum qty + product count), and a **Print** button (`window.print()`; `@media print`
  hides chrome). Quantities render integer-or-2dp.
- **Actions (operator, when not COMPLETED/CANCELLED):** **Optimize** (same `useOptimizeRoute` +
  fallback toasts as run detail); **Change Driver** (`ChangeDriverModal` → `useUpdateRouteRun {driverId}`);
  **Cancel Run** (`CancelRunModal` — warns "{N} customers with orders will not be delivered" →
  `useUpdateRouteRunStatus {status:"CANCELLED"}`); **Print** manifest.
- **States:** full-screen spinner (run/packing loading); "Route run not found." + Back; a red
  **cancelled banner** ("This route run has been cancelled.") when CANCELLED; "No customers have active
  orders for this run." (no required stops); "Nothing to pack" empty manifest; per-mutation spinners.
  POD note: **this web screen does not capture signature/photo POD** — POD capture (photo/signature/
  note) lives only in the **driver mobile** app
  ([`../mobile-inventory/03-driver.md`](../mobile-inventory/03-driver.md)); web surfaces driver notes
  read-only on the run detail and consumes the completed statuses via realtime.

### Route template detail — `/routes/templates/[id]`

- **File:** `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx` (+ `TemplateRouteMap.tsx`)
- **Purpose:** Edit a reusable **template** — rename, set default driver, add/reorder/remove stops,
  toggle active, optimize, analyze ETAs, review the pending-order packing list, and dispatch a run.
- **Shows:** Top bar: **← Routes**, **inline-editable name** (click to rename, Enter/Escape/blur to
  save), Active/Inactive `Badge`, a green **Depot** chip (route or default depot), a **default-driver**
  select, **Activate/Deactivate** toggle, **Delete** (inline confirm), **Optimize** (disabled < 2
  stops), **Dispatch Run**. Body: **40% left tabbed panel + 60% map** split.
  - **Stops (N)** tab — draggable (`@dnd-kit`) stop rows (grip, number badge, business name, address,
    remove-with-confirm); selecting a row highlights its map pin; an **Add customer to route…** search
    with dropdown (debounced; excludes already-added).
  - **Orders (N)** tab — pending/confirmed orders for the route's customers, grouped by customer, each
    with status pill + line items ×qty.
  - **Packing List** tab — aggregated Product / SKU / Total Qty table (with per-customer breakdown line)
    - **Print**.
  - **Analysis** tab — **Departure Time** input + **Analyze Route** → `useAnalyzeRoute` (POST
    `/routes/{id}/analyze`): a summary card, an ETA table (**# · Customer · ETA(+travel min) · Window ·
    Status · AI Note**) with on-time/late/ok/warning/critical badges, and a **Suggestions** list; a
    notice to configure an Anthropic key when `!configured`.
- **Actions:** rename (`useUpdateRoute {name}`); set default driver (`useUpdateRoute {driverId}`);
  toggle active (`useUpdateRoute {isActive}`); add stop (`useAddStopToRoute`); remove stop (optimistic +
  `useRemoveStop`, renumbers, rolls back on error); drag reorder (optimistic + `useReorderStops`);
  **Optimize** (`useOptimizeTemplate` POST `/routes/{id}/optimize` — remaps locally from `stopOrder`
  before refetch; toast "Route optimized" / "(local fallback)"); **Analyze** (`useAnalyzeRoute`);
  **Delete** (`useDeleteRoute` → push `/routes`); **Dispatch Run** (`DispatchModal` — Scheduled Date,
  **Departure Time** prefilled from `routeSettings.defaultStartTime`, Driver → `useCreateRouteRun` →
  push `/routes/{newRunId}`).
- **States:** full-screen spinner; "Route template not found." + Back; empty per tab ("No stops yet.
  Add customers below." / "No pending orders…" / "No pending orders to pack." / Analysis idle
  prompt); inline rename spinner; per-mutation spinners; optimize disabled title "Need at least 2
  stops to optimize".

### My Routes (operator-as-driver) — `/routes/my-runs`

- **File:** `apps/web/app/(dashboard)/routes/my-runs/page.tsx`
- **Purpose:** Thin self-service view for an operator who can also drive — the runs **assigned to me**,
  split Today vs Upcoming.
- **Shows:** `PageHeader` "My Routes" / "Runs assigned to you." Two `CardShell`s — **Today** and
  **Upcoming** — over `useRouteRuns({ assignedToMe: true, limit: 100 })` (**polls every 60 s**). Each
  `RunRow`: route name, "{date} · {N} stops", status `Badge`, **Open** → `/routes/{id}`. Upcoming is
  future-dated, sorted ascending, capped at 20.
- **Actions:** Open a run (→ run detail). No start/complete controls on **web** — starting/completing a
  run is a **driver-mobile** action; web operators drill into the run detail / dispatch panel.
- **States:** if **not** `canActAsDriver`: a gate card — "This view is only available to operators who
  can also act as drivers. Ask your admin to enable driver mode on your account." Otherwise per-card
  skeleton / error banner / empty ("No runs scheduled for you today." / "No upcoming runs assigned to
  you.").

---

## Key flows

- **Build & dispatch a route:** `/routes` → **New Route** → `/routes/create` (name + driver → search/
  click-map to add stops → optionally **Optimize Stop Order** → **Create Route** = POST `/routes` +
  sequential POST `/routes/{id}/stops`) → land on `/routes` → open the template
  (`/routes/templates/{id}`) → optionally reorder/optimize/analyze → **Dispatch Run** modal (date +
  departure time + driver → POST `/route-runs`) → land on the new run `/routes/{runId}` → **Dispatch
  Panel** to review Must-Stop checklist + print the Loading Manifest. (A template can also be
  dispatched straight from the routes list via the play ▶ action.)
- **Live delivery + POD:** operator opens `/routes/{id}/dispatch`, prints the manifest, assigns/changes
  the driver, and can **Optimize** or **Cancel** while SCHEDULED/IN_PROGRESS. Progress advances as the
  **driver mobile** app completes stops (POD photo/signature/note captured there); the web realtime
  handler invalidates `routes`/`orders` on `route.stop.completed`, so the run detail progress bar and
  dispatch board refresh live. Driver notes appear read-only under each stop on the run detail.
- **Recurring route → orders:** RouteFlow **web** has no dedicated recurring-route-template scheduler
  screen — a template is reusable and dispatched **manually** each time via **Dispatch Run** (choosing
  a date/departure/driver), which creates a fresh `RouteRun`. The `/routes/templates/[id]` **Orders**
  tab shows the pending orders that will be pulled into that run's manifest. (Recurring **invoices**
  are a separate Finance feature, not routes.)

---

## Use cases

- As an **operator**, I want a live board of what's running now + who's scheduled today so I can spot a
  stalled or unassigned run at a glance. (`/dispatch`)
- As an **operator**, I want to assemble an ordered list of customer stops on a map into a reusable
  template so I can dispatch the same route repeatedly. (`/routes/create` → `/routes/templates/{id}`)
- As a **dispatcher**, I want the app to auto-sequence stops for the shortest path — before dispatch on
  the template, or on the run — so drivers don't backtrack. (Optimize on create / template / run)
- As an **operator**, I want to turn a template into a dated run with a departure time and driver, then
  hand the driver a printed Must-Stop checklist + loading manifest. (`/routes/templates/{id}` Dispatch →
  `/routes/{id}/dispatch` Print)
- As an **operator**, I want to reschedule, reassign, cancel, or delete a run inline without leaving the
  routes list. (`/routes` active-run cards)
- As an **operator**, I want ETA + delivery-window analysis so I know which stops risk being late.
  (`/routes/templates/{id}` **Analysis** tab)
- As an **operator-driver**, I want to see just the runs assigned to me, today and upcoming.
  (`/routes/my-runs`)

---

## Business rules & edge cases

- **Two-noun model:** templates (`Route`, `isActive` only) vs runs (`RouteRun`, four statuses). The
  `/routes/[id]` path resolves a **run**; the template lives at `/routes/templates/[id]`.
- **Run status machine (authoritative):** `SCHEDULED → IN_PROGRESS → COMPLETED`; `CANCELLED` is a
  terminal escape reachable from SCHEDULED or IN_PROGRESS. There is **no** DRAFT or PLANNED status. All
  status badges collapse anything non-terminal to SCHEDULED as the default arm.
- **Status-gated controls:** reorder = SCHEDULED only; Edit = not COMPLETED/CANCELLED; Cancel =
  SCHEDULED or IN_PROGRESS; Delete = SCHEDULED only; Optimize = not COMPLETED/CANCELLED. Once
  COMPLETED/CANCELLED a run is effectively read-only (dispatch controls hidden, cancelled banner shown).
- **Operator-only writes:** the run-detail and dispatch mutation controls are additionally gated on
  `user.role === "OPERATOR"` (`isOperator`), so a driver/other role viewing a run gets a read-only view.
- **Duplicate-active-run guard:** the API rejects dispatching a template that already has a SCHEDULED/
  IN_PROGRESS run. The routes list therefore shows **all** active runs regardless of date (not just
  today) so the blocking run can be found and cancelled.
- **Dispatch date defaults differ:** the `/routes` list `DispatchModal` uses
  `new Date().toISOString().split("T")[0]` (**UTC** day — can be a day ahead in evening local time),
  whereas `/dispatch` and `/routes/my-runs` use a `todayLocalISO()` local-day helper. (Inconsistency
  worth unifying — see the mobile BUG-W-8 local-date discipline note.)
- **Optimization:** create-page optimize is **client-side** (haversine nearest-neighbour + 2-opt,
  depot-anchored when a depot is set; stops without coords are appended last). Template/run optimize
  call the server (`/routes/{id}/optimize`, `/route-runs/{id}/optimize`) which uses ORS route
  intelligence and **falls back** to distance-based ordering (`usedFallback` + `fallbackReason`:
  `ORS_NOT_CONFIGURED` / `ORS_RATE_LIMITED` / `ORS_HTTP_ERROR` / `ORS_NETWORK_ERROR`) surfaced as a
  warning toast. Optimize requires **≥ 2 stops** (template button disabled below that).
- **Geocode handling:** stops without lat/lng are flagged (⚠ "No GPS coordinates" on create) and are
  excluded from map pins / the optimization; the map degrades gracefully.
- **Reordering is optimistic:** template + run drag-reorder update local state immediately, PATCH the
  new `{id, stopNumber}[]` order, and roll back (re-sort from server) + toast on error. Stop removal is
  likewise optimistic with renumbering.
- **Manifest / packing list:** the dispatch panel splits stops into **Must Stop** (has orders) vs
  **Optional** (no orders); the Loading Manifest aggregates line items into per-product totals with a
  per-customer breakdown; quantities render integer or 2-dp; the whole console is print-optimized.
- **Realtime:** `useRealtimeUpdates` (Socket.io) invalidates `["routes"]` + `["orders"]` on
  `route.stop.completed`, and invalidates `["drivers"]` + `["routes"]` (plus a toast) on
  `driver.status.updated`, keeping the dispatch board, run detail, and my-runs fresh without manual
  refresh. Dispatch **Active Now** additionally polls every 30 s; my-runs every 60 s.
- **Driver assignment is optional at dispatch:** a run can be created **Unassigned** and reassigned
  later via the active-run card **Edit** (`EditRunModal`) or the dispatch panel **Change Driver** modal;
  driver selects list **ACTIVE** drivers only. The template carries an optional **default driver** that
  seeds new runs.
- **POD is mobile-owned:** web has no signature/photo capture — proof of delivery is captured in the
  driver mobile app and folded into the complete-with-payment write; web only reads driver notes and
  completed statuses.
- **Multi-tenant:** every query (routes, runs, drivers, customers, settings) is tenant-scoped via the
  JWT; the impersonation token is read-only so an impersonating super-admin cannot dispatch/cancel.
- **Coverage:** `e2e/02-operator.spec.ts` **OP-10** only asserts that `/routes` renders a table/route/
  empty container — the run lifecycle is not e2e-covered here.

---

## Relevant files

- `apps/web/app/(dashboard)/dispatch/page.tsx` — dispatch overview board.
- `apps/web/app/(dashboard)/routes/page.tsx` — routes list (active runs + templates, dispatch/bulk-delete modals).
- `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx` — inline edit-run (driver/date/notes).
- `apps/web/app/(dashboard)/routes/create/page.tsx` — route builder (map + form split, client optimize).
- `apps/web/app/(dashboard)/routes/create/CreateRouteLeftPanel.tsx` — builder left panel (name/driver/stops/search).
- `apps/web/app/(dashboard)/routes/create/CreateRouteMap.tsx` — builder Google map (click pins to add stops, depot).
- `apps/web/app/(dashboard)/routes/[id]/page.tsx` — route **run** detail (stop list + map, reorder/optimize/edit/cancel/delete).
- `apps/web/app/(dashboard)/routes/[id]/RouteMap.tsx` — run-detail map.
- `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx` — live dispatch + Must-Stop checklist + printable Loading Manifest.
- `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx` — route **template** detail (Stops/Orders/Packing/Analysis tabs, dispatch).
- `apps/web/app/(dashboard)/routes/templates/[id]/TemplateRouteMap.tsx` — template map.
- `apps/web/app/(dashboard)/routes/my-runs/page.tsx` — operator-as-driver "My Routes" self-view.
- `apps/web/lib/api/routes.ts` — all hooks/types: `useRoutes`, `useRoute`, `useCreateRoute`,
  `useUpdateRoute`, `useAddStopToRoute`, `useRemoveStop`, `useReorderStops`, `useDeleteRoute`,
  `useRouteRuns`, `useRouteRun`, `useCreateRouteRun`, `useUpdateRouteRun`, `useUpdateRouteRunStatus`,
  `useDeleteRouteRun`, `useReorderRunStops`, `useOptimizeTemplate`, `useOptimizeRoute`,
  `useAnalyzeRoute`/`useAnalyzeRouteRun`, `useRoutePackingList`, `useRunPackingList`,
  `useCustomerRouteAssignments`, `useRouteSettings`/`useUpdateRouteSettings`.
- `apps/web/lib/api/drivers.ts` — `useDrivers` (driver selects, dispatch board).
- `apps/web/lib/hooks/useRealtimeUpdates.ts` — `route.stop.completed`, `driver.status.updated` invalidation.
- `apps/web/lib/socket.ts` — Socket.io connect/disconnect.
- `apps/web/e2e/02-operator.spec.ts` — OP-10 routes-list smoke check.

---

## 💡 Faster ways

_Improvement ideas — not current behavior. Quarantined here so the redesign can adopt or reject them._

- **One-click optimize + dispatch.** Today the operator opens a template, clicks Optimize, waits, then
  opens the Dispatch modal and picks a date/driver. A single **"Optimize & Dispatch"** action (optimize
  server-side, then open the dispatch modal pre-seeded with the default driver + `defaultStartTime`)
  would collapse three steps into one.
- **Map-first builder.** The create screen already renders a map, but stop-adding is search-driven and
  the map is secondary. Invert it: let the operator lasso/box-select pins, drag to reorder the _route
  line_ directly on the map, and show the live path distance/ETA as they go — the form becomes a thin
  side rail. (The client already computes haversine path length for optimization.)
- **Drag-drop reorder everywhere, consistently.** Run detail supports DnD reorder only while SCHEDULED
  and the create page's grip handle is **decorative** (no DnD wired — reordering there is add/remove
  only). Wire real drag-reorder into the create page and expose an in-flight "resequence remaining
  stops" on IN_PROGRESS runs so a dispatcher can re-plan mid-route.
- **Unify the dispatch-date default.** The list modal uses UTC `toISOString()` while other surfaces use
  a local-day helper; standardize on `todayLocalISO()` so an evening dispatch never lands a day ahead.
- **True recurring templates.** Add a schedule (e.g. "every Mon/Wed/Fri at 08:00") that auto-creates
  runs, instead of requiring a manual Dispatch each day — closing the "recurring route → orders" gap the
  brief anticipated but the code doesn't yet implement.
- **Live driver location on the dispatch map.** Web consumes `driver.status.updated` for badges but the
  dispatch/run maps are static stop plots. Plotting the driver's last-known GPS (already streamed to the
  API from mobile) would make `/routes/[id]/dispatch` a true live board.
