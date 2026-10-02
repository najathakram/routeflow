## 9. Tenant Admin — (tenant)

> **Important design note:** `TENANT_ADMIN` users are routed by the app to `/(operator)/home` —
> the **`(operator)` screens ARE the tenant-admin experience today**. The `(tenant)` tab set below
> (today, dispatch, finance, warehouse, more) is a parallel, near-duplicate scaffold whose
> navigation points _into_ the `(operator)` stack and is **not currently reachable from role
> routing**. Treat operator as the canonical surface; design `(tenant)` only if the new version
> intends to make it a distinct, reachable experience.

**Role(s):** `TENANT_ADMIN` (the tenant owner/org admin) — same JWT role family as `OPERATOR`. • **Entered via:** A dedicated 5-tab bottom bar (Today / Dispatch / Finance / Warehouse / More). **Important routing caveat (from the code):** role routing does _not_ currently land anyone in this group. `defaultRoleForUser` (`lib/auth-store.ts:36`) maps both `OPERATOR` and `TENANT_ADMIN` to the `"operator"` active role, and the root layout (`app/_layout.tsx:160-166`) then `router.replace`s that user to `/(operator)/home`. The only reference to `/(tenant)/*` anywhere in the app is `today.tsx`'s avatar pushing to `/(tenant)/more`. So `(tenant)` is a **parallel, near-duplicate tab shell** of the operator experience: its own Today dashboard plus **thin relays** that immediately forward into the live `(operator)` stack.

This area is the org-owner's cockpit. In practice it surfaces the same operator capabilities (orders, dispatch, finance, warehouse, drivers, analytics, settings) — the differentiator is a tenant-branded "Today" command dashboard and a "More" hub scoped to the whole business rather than a single operator's queue. Three of its five tabs are one-line redirects into `(operator)`, so the tenant group adds no distinct screens beyond Today and More.

### Screens

#### Tenant Tab Bar (shell) — `/(tenant)/_layout.tsx`

- **File:** `apps/mobile/app/(tenant)/_layout.tsx`
- **Purpose:** Defines the 5-tab bottom navigation for the tenant-admin shell using the shared `IosTabBar`.
- **Shows:** Five tabs with Ionicons — **Today** (`sunny-outline`), **Dispatch** (`car-outline`), **Finance** (`receipt-outline`), **Warehouse** (`business-outline`), **More** (`ellipsis-horizontal`). Active tint = `ios.brand`, inactive = `ios.gray[1]`; headers hidden.
- **Actions:** Each tab swaps the active screen. (Unlike the operator layout, this layout does **not** mount `useSocket()` or the offline banner — those live only in `(operator)/_layout.tsx`.)
- **States:** No loading/empty/error at the shell level; purely structural.

#### Today (Tenant dashboard) — `/(tenant)/today`

- **File:** `apps/mobile/app/(tenant)/today.tsx`
- **Purpose:** The owner's morning command view — personal route status + org-wide dispatch readiness + KPIs + today's routes.
- **Shows:**
  - **NavBar** large title "Today", eyebrow = today's date (`WEEKDAY, MON D`, uppercased), subtitle = `"{N} route(s) today"` (a single space while `routesLoading`). Trailing: a notifications bell (`/(operator)/exceptions`) with a **red dot badge** when `stats.returnsToProcess > 0`, and a brand avatar showing the user's initials (derived from `user.username`, split on `. _ whitespace`, first 2 letters, fallback `"OP"`).
  - **My-route card** (driver-style): shows the current user's own `activeRun.route.name` with an "On route" brand pill if `useActiveRouteRun()` returns a run; else `nextRun.route.name` with a gray "Scheduled" pill from `useScheduledRouteRuns()`; else an empty "No route assigned today" state. (Both run queries call `GET /route-runs?assignedToMe=true&status=IN_PROGRESS|SCHEDULED`.)
  - **Dispatch-readiness hero** (brand gradient): eyebrow "DISPATCH READINESS", a large `{pct}%`, subtitle `"{loaded} of {total} routes rolling"`, and a progress bar. Readiness % = routes whose latest run status is `IN_PROGRESS` or `COMPLETED`, divided by total routes.
  - **KPI grid (4 tappable cards)** from `useAdminDashboard()`: **Pending orders** (`stats.pendingOrders`), **Active drivers** (`stats.activeDrivers`, green), **Low stock** (`stats.lowStockProducts`, orange), **Overdue invoices** (`stats.invoicesOverdue`, red).
  - **"Routes today"** list (up to 6 of first 10 routes from `useAdminRoutes({limit:10})`): each row shows a 2-letter route badge, `"{route.name} · {driverName}"`, `"{stopCount} stop(s)"` from `_count.stops`, a status **Pill**, and a progress track. `driverName` resolved from `useAdminDrivers()` map (firstName/lastName → username → "Driver"; "Unassigned" if no driver). Status label logic: latest run `IN_PROGRESS` → "On route" (brand, 50%), `COMPLETED` → "Rolled" (green, 100%), no `driverId` → "No driver" (red, 0%), else "Scheduled" (gray, 0%).
- **Actions:**
  - Bell → `router.push("/(operator)/exceptions")`
  - Avatar → `router.push("/(tenant)/more")` _(the only real intra-tenant navigation)_
  - My-route card → `router.push("/(driver)/route")` (opens the driver view)
  - Hero "New order" → `/(operator)/new-order`; "Dispatch" → `/(operator)/dispatch`; "Fleet" → `/(operator)/fleet`
  - KPI "Pending orders" → `/(operator)/orders?status=PENDING`; "Active drivers" → `/(operator)/drivers`; "Low stock" → `/(operator)/warehouse`; "Overdue invoices" → `/(operator)/invoices?status=OVERDUE`
  - Section "All" link → `/(operator)/dispatch`
  - Route row → `/(operator)/route-runs/{todaysRunId}` if a run exists, else `/(operator)/routes/{route.id}`
  - (Data hooks are read-only queries; **no mutations fire from this screen**.)
- **States:** **Loading** — spinners for the my-route card (`activeRunLoading`), the KPI block (`statsLoading || !stats`), and the routes list (`routesLoading`). **Empty** — "No route assigned today" card; "No routes scheduled" centered text. **No pull-to-refresh** (plain `ScrollView`); freshness comes from `useAdminDashboard`'s `refetchInterval: 120_000` (60s staleTime) and per-query `refetchOnWindowFocus`. **No offline banner here** (the tenant layout omits it). All `stats` sub-fetches are individually `try/catch`-guarded to `0`, so partial API failures degrade to zeros rather than an error screen.

#### Dispatch (relay) — `/(tenant)/dispatch`

- **File:** `apps/mobile/app/(tenant)/dispatch.tsx`
- **Purpose:** Not a screen — a redirect. On mount it `router.push("/(operator)/dispatch")`.
- **Shows:** A blank `ios.bg` view for the frame before the push lands.
- **Actions:** Auto-forward to the operator Dispatch tab.
- **States:** Momentary blank view only.

#### Finance (relay) — `/(tenant)/finance`

- **File:** `apps/mobile/app/(tenant)/finance.tsx`
- **Purpose:** Redirect. `router.push("/(operator)/finance")` on mount.
- **Shows:** Blank `ios.bg` view.
- **Actions:** Auto-forward to the operator Finance tab.
- **States:** Momentary blank view only.

#### Warehouse (relay) — `/(tenant)/warehouse`

- **File:** `apps/mobile/app/(tenant)/warehouse.tsx`
- **Purpose:** Redirect. `router.push("/(operator)/warehouse")` on mount.
- **Shows:** Blank `ios.bg` view.
- **Actions:** Auto-forward to the operator Warehouse tab.
- **States:** Momentary blank view only.

#### More (Org hub) — `/(tenant)/more`

- **File:** `apps/mobile/app/(tenant)/more.tsx`
- **Purpose:** The owner's directory of every management area, plus identity/account controls. This is the tenant group's real second screen (everything else relays out).
- **Shows:**
  - **Identity row:** brand avatar with initials (from `user.username`), `user.username` (fallback "Owner"), and the tenant/business name from `useTenantStore((s) => s.branding?.businessName)` (fallback "Tenant") — the org-level label that distinguishes this from a plain operator.
  - **MANAGE group (ListRows, each with chevron):** Orders ("Create, edit, approve orders"), Customers ("Directory & addresses"), Products ("Catalog & stock"), Invoices ("Statements & payments"), Returns ("Approvals & credits"), Purchase Orders ("Restock & receive inventory"), Expenses ("Track business spending"), Routes ("Templates & stops"), Fleet ("Live map & driver tracking"), Drivers ("Team management").
  - **WAREHOUSE group:** Exceptions ("Urgent orders, late routes, pending returns"), Pick & load ("Warehouse scanning").
  - **INSIGHTS group:** Analytics ("Revenue, top items, margins"), Settings ("Business details & notifications").
  - **COMMUNICATION group:** Messages ("Dispatch & drivers").
  - **ACCOUNT group:** Profile, Change password.
  - **Sign-out** row (red).
- **Actions:** Every row pushes into `(operator)`: Orders → `/(operator)/orders`, Customers → `/(operator)/customers`, Products → `/(operator)/products`, Invoices → `/(operator)/invoices`, Returns → `/(operator)/returns`, Purchase Orders → `/(operator)/purchase-orders`, Expenses → `/(operator)/expenses`, Routes → `/(operator)/routes`, Fleet → `/(operator)/fleet`, Drivers → `/(operator)/drivers`, Exceptions → `/(operator)/exceptions`, Pick & load → `/(operator)/pick`, Analytics → `/(operator)/analytics`, Settings → `/(operator)/settings`, Messages → `/(operator)/messages`, Profile → `/(operator)/profile`, Change password → `/(operator)/change-password`. **Sign out** → `useAuthStore().logout()` (clears user/auth/activeRole; `apiLogout()`).
- **States:** Static list — no loading/empty/error. `businessName` and `username` fall back to placeholders if unset. **Org-level controls that Settings surfaces** (via `/(operator)/settings`, backed by `useBusinessSettings`/`useUpdateBusinessSettings` on `/settings` and `useAdminUsers`/`useCreateAdminUser`/`useToggleUserStatus` on `/users`): business name/owner/phone/email/address, **tax rate**, and **team-member management** (create operator via `POST /users/operator`, activate/suspend via `PATCH /users/:id/status`, role pills) — these are the true org-admin capabilities the tenant surfaces beyond a line operator.

### Key flows (end-to-end journeys through this area)

- **Morning readiness check:** `(tenant)/today` → read the dispatch-readiness % and the my-route card → tap a route row → `(operator)/route-runs/{runId}` (or `routes/{id}` if not yet run). No mutation on the tenant side; commits happen in the operator route-run screens.
- **Fix an exception surfaced by a KPI:** `(tenant)/today` → bell or a red KPI (Overdue invoices / Low stock) → `(operator)/exceptions` / `invoices?status=OVERDUE` / `warehouse` → act there.
- **Create an order as owner:** `(tenant)/today` hero "New order" → `(operator)/new-order` (shared NewOrder flow) → the commit (`POST /orders`) happens in the operator stack; the tenant Today KPIs then refresh on their interval.
- **Manage the org:** `(tenant)/today` avatar → `(tenant)/more` → pick any MANAGE/INSIGHTS row → the corresponding `(operator)` screen. E.g. More → Settings → `(operator)/settings` → add a team member (`POST /users/operator`) or edit tax rate (`PATCH /settings`).
- **Sign out:** `(tenant)/more` → "Sign out" → `logout()` → root layout redirects to auth.

### Use cases

- As the **tenant owner**, I want a one-glance dashboard of today's dispatch readiness and the four risk KPIs so that I know whether the day is on track. (path: `(tenant)/today`)
- As the **tenant owner**, I want to jump from an overdue-invoice or low-stock number straight to the filtered list so that I can act without hunting through menus. (path: `today` → `(operator)/invoices?status=OVERDUE` / `(operator)/warehouse`)
- As the **tenant owner**, I want a single hub listing every management area of my business so that I can reach orders, customers, products, finance, fleet, and settings from one place. (path: `today` → `(tenant)/more` → any `(operator)` area)
- As the **tenant owner**, I want to add or suspend an operator and set my tax rate so that I control who runs the business and how it prices. (path: `more` → Settings → `(operator)/settings`)
- As the **tenant owner** who also drives, I want my own active/next route on the same dashboard so that I can open the driver view directly. (path: `today` my-route card → `(driver)/route`)

### Business rules & edge cases

- **`(tenant)` is a shadow of `(operator)`.** Role routing sends `TENANT_ADMIN` to `/(operator)/home`, not `/(tenant)`. Dispatch/Finance/Warehouse are literal `router.push` redirects into `(operator)`, and every More row and Today action targets `(operator)/*`. A redesign should treat `(tenant)` as either (a) the canonical owner shell to be wired into role routing, or (b) dead code to fold into `(operator)`; there is currently **no tenant-only business screen** other than Today and More.
- **No socket/offline wiring in the tenant shell.** `(tenant)/_layout.tsx` does **not** call `useSocket()` and shows **no offline banner** — both exist only in `(operator)/_layout.tsx`. So the tenant Today dashboard has no real-time push updates and no offline-queue indicator; it relies on interval/focus refetch. Any offline replay / queued-action UX only appears once the user relays into the operator stack.
- **Dashboard stats are aggregated client-side, defensively.** There is no `/dashboard/stats` endpoint; `useAdminDashboard` fans out `limit:1` list calls reading `meta.total` (`/orders?status=PENDING`, `/drivers?status=ACTIVE`, `/customers`, `/returns?status=PENDING`, `/products?stockStatus=LOW|OUT_OF_STOCK`) plus `/bookkeeping/summary`. Each is `try/catch`→`0`, so a failing endpoint silently zeroes its KPI rather than erroring the screen.
- **Low-stock definition.** `lowStockProducts = max(0, LOW total − OUT_OF_STOCK total)`. The server's `LOW` filter is `currentStock <= 5` (includes zero/negative), so out-of-stock is subtracted to show items that are low **but still sellable (1–5 units)**.
- **Overdue invoices** come from `/bookkeeping/summary.overdueCount` (SENT/VIEWED/PARTIAL with `dueDate < now`), not a naive invoice-status filter.
- **Route status gating** drives both the readiness hero and each route pill: a route counts as "rolling"/"loaded" only when its latest run is `IN_PROGRESS` or `COMPLETED`; a route with no `driverId` renders "No driver" (red). Routes list is capped (fetch `limit:10`, render first 6).
- **Route row target depends on run existence:** a route with a `runs[0].id` opens the run detail (`/route-runs/{id}`); without one, it opens the route template (`/routes/{id}`).
- **Multi-tenant identity:** the More header's business name comes from `tenant-store` branding, which is keyed off the persisted `tenantSlug` (secure-store on native, `localStorage` on web) used for the `X-Tenant-Slug` header; branding is re-fetched lazily and falls back to "Tenant" when absent.
- **Money/inventory conventions are inherited, not enforced here.** The tenant screens render totals but don't do line math; boxed-line proration (`unitPrice × (boxes + pieces/unitsPerBox)`), integer boxes/pieces, per-line price-override (`overrideReason`, `originalPrice` strikethrough) and weighted-average cost all live in the shared operator flows the tenant relays into (`AdminOrder`/`AdminProduct` types carry `boxes`/`pieces`/`invoicedQty`/`standardCost`/`overrideReason`). Any redesign of tenant screens must preserve those downstream conventions rather than re-deriving `qty × unitPrice`.
