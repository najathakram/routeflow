# 03 — Operator Dashboard: Shell + Overview

**Role(s):** `OPERATOR`, `TENANT_ADMIN` (canonical operator surface); `CUSTOMER` and `DRIVER`
share the same shell with a **reduced nav + path allow-list**; `SUPER_ADMIN` falls into the
operator nav when landing here (usually via impersonation). • **Entered via:** the `(dashboard)`
route group — every operator-side page (`/dashboard`, `/orders`, `/routes`, `/invoices`, …) renders
inside `apps/web/app/(dashboard)/layout.tsx`. This file is the chrome around all of Ecosystem 3.

This section documents the **shell** (sidebar nav trees per role, collapsible rail + mobile drawer,
auth/role guards, header, notifications, command palette, keyboard shortcuts, impersonation banner,
PWA prompt) and the **operator overview** at `/dashboard`. Everything is tenant-scoped through the
JWT; branding is injected as CSS vars; realtime updates flow through TanStack Query invalidation.

---

## Shell

### Layout composition — `apps/web/app/(dashboard)/layout.tsx`

`DashboardLayout` wraps children in a fixed provider stack (outermost → innermost):

```
ToastProvider → PageTitleProvider → AuthGuard → DashboardShell → (RouteGuard) → children
```

- **`ToastProvider`** (`@routeflow/ui/web`) — global toast host; realtime events raise toasts here.
- **`PageTitleProvider`** (`apps/web/lib/page-title-context.tsx`) — holds the current page title;
  `setTitle(x)` also sets `document.title = "{x} | RouteFlow"`. Each page calls `usePageTitle()`
  → `setTitle()` in an effect (the overview sets `"Dashboard"`).
- **`AuthGuard`** — auth gate (see below).
- **`DashboardShell`** — the visible chrome (sidebar / header / main / palette / modals).
- **`RouteGuard`** — role-based path allow-list (see below), nested inside `AuthGuard`.

> Note: `TenantProvider` (branding injection) is documented here because the shell consumes its CSS
> vars, but it is mounted higher up (root layout / providers), **not** inside `(dashboard)/layout.tsx`.

---

### Sidebar navigation trees (per role)

Nav is data-driven: `type NavEntry = NavLeaf | NavGroup`. A **leaf** is a single link; a **group**
is a collapsible header with child leaves. `getNavForRole(role, canActAsDriver)` picks the tree;
`DashboardShell` then splices in a **Tobacco** leaf at runtime when the tenant has the addon.

#### OPERATOR / TENANT_ADMIN / SUPER_ADMIN / unknown → `OPERATOR_NAV`

- **Dashboard** *(leaf)* → `/dashboard`
- **Orders** *(group)*
  - All Orders → `/orders`
  - Returns → `/returns`
- **Dispatch** *(group)*
  - Overview → `/dispatch`
  - Routes → `/routes`
  - Drivers → `/drivers`
  - *(My Routes → `/routes/my-runs` — appended here only when `user.canActAsDriver`)*
- **Customers** *(leaf)* → `/customers`
- **Warehouse** *(group)*
  - Inventory → `/inventory`
  - Products → `/products`
  - Suppliers → `/suppliers`
- **Finance** *(group)*
  - Overview → `/finance/dashboard`
  - Invoices → `/invoices`
  - Shipments → `/shipments`
  - Estimates → `/estimates`
  - Credit Notes → `/credit-notes`
  - Payments → `/finance/payments`
  - Expenses → `/finance/expenses`
  - Reports → `/finance/reports`
- **Analytics** *(leaf)* → `/analytics` *(top-level: app-wide, not nested under Finance)*
- **Tobacco** *(leaf, conditional)* → `/tobacco` — spliced **immediately after Analytics** by
  `DashboardShell` when `useHasAddon(TOBACCO_ADDON)` is true; suppressed for CUSTOMER/DRIVER
  (`apps/web/lib/api/tobacco.ts`).
- **Settings** *(leaf)* → `/settings`

`canActAsDriver` variant: `getNavForRole` maps `OPERATOR_NAV` and appends a **My Routes**
(`/routes/my-runs`) leaf inside the **Dispatch** group (rather than a stand-alone top-level item) so
all dispatch tools stay grouped.

#### CUSTOMER → `CUSTOMER_NAV`

- **Dashboard** *(leaf)* → `/dashboard`
- **Orders** *(group)*
  - My Orders → `/orders`
  - Returns → `/returns`
- **Invoices** *(leaf)* → `/invoices`
- **Settings** *(leaf)* → `/settings`

#### DRIVER → `DRIVER_NAV`

- **Dashboard** *(leaf)* → `/dashboard`
- **My Routes** *(leaf)* → `/routes`
- **Settings** *(leaf)* → `/settings`

---

### Rail behavior (collapse / expand / accordion / mobile drawer)

- **Desktop rail** (`<aside>`, `lg:` and up): dark **navy** background. Expanded width `lg:w-60`
  (240px); collapsed width `lg:w-16` (64px). Width animates (`transition-[width] duration-200`).
- **Collapse toggle**: bottom-of-rail button (`ChevronLeft` "Collapse" / `ChevronRight` icon-only).
  Persisted to `localStorage["rf-sidebar-collapsed"]`. Initial state auto-collapses when
  `window.innerWidth < 768`, else reads the saved preference.
- **Collapsed rail**: each group flattens into **icon-only** child links (no headers); each `NavLink`
  gets a `title={label}` tooltip; the logo centers and hides the tenant name.
- **Single-open accordion** (expanded rail only): `SidebarNav` tracks one `openGroup` at a time —
  opening a group closes the others so the nav never overflows. **Exception:** the group that
  contains the active route is force-expanded (`open || isAnyChildActive`) so the current page is
  never hidden. `activeGroupLabel` is recomputed from `pathname` and re-opens on navigation.
- **Active state**: leaf is active when `pathname.startsWith(href)` — **except** Dashboard, which is
  active only on exact `pathname === "/dashboard"` (so `/dispatch` etc. don't light up Dashboard).
  Active leaf renders `bg-white text-navy`; inactive is `text-white/70` (chosen for WCAG AA — old
  `/40` failed contrast).
- **Mobile drawer** (below `lg`): the static rail is hidden; a hamburger (`Menu`) in the header opens
  an off-canvas drawer (`w-64 max-w-[82%]`, navy, slide-in from left, dark backdrop). Drawer **auto-
  closes on route change** (effect on `pathname`) and on tapping a link (`onNavigate`). **Esc closes**
  it and body scroll is locked while open. Drawer always renders the **expanded** (non-collapsed) nav.
- **Skip link**: a visually-hidden "Skip to content" anchor (`#main-content`) appears on focus.

---

### Auth guard + force-password-change — `AuthGuard`

- Reads `useAuth()` → `{ isAuthenticated, isLoading, user }`.
- While `isLoading`: renders a full-screen centered spinner.
- If not authenticated (post-load): `router.push("/login")`, renders `null`.
- If `user.forcePasswordChange`: `router.push("/change-password")`, renders `null` — a hard gate that
  blocks the whole dashboard until the password is reset.
- Otherwise renders `<RouteGuard>{children}</RouteGuard>`.
- Locked by **CC-01** (unauthenticated `/dashboard` → `/login`) and **CC-09** (session persists across
  reload) in `apps/web/e2e/05-cross-cutting.spec.ts`.

### Role-based PATH guard — `RouteGuard`

Prefix-matched allow-lists gate which paths a reduced role may open. On every `pathname`/`role`
change, if the role has an allow-list and the current path isn't allowed → `router.replace("/dashboard")`.

- **CUSTOMER** `CUSTOMER_ALLOWED`: `/dashboard`, `/orders`, `/returns`, `/invoices`, `/settings`.
- **DRIVER** `DRIVER_ALLOWED`: `/dashboard`, `/routes`, `/settings`.
- **OPERATOR / TENANT_ADMIN / SUPER_ADMIN**: no client allow-list (`allowed === null`) — full access.
- Match rule: `pathname === p || pathname.startsWith(p + "/")`.

> This is a **client-side** convenience guard (redirect only); the API remains the real authority.
> Verified by **CU-03** (`/routes` → redirect/403) and **CU-04** (`/drivers` → redirect/403) in
> `apps/web/e2e/03-customer.spec.ts`; operator↔admin isolation by **CC-04** in `05-cross-cutting`.

---

### Header — `Header`

Sticky top bar (`h-16`, white, bottom border), left→right:

- **Mobile nav trigger** (`Menu`, `lg:hidden`) → opens the drawer.
- **Back button** (`ArrowLeft`) — shown only on sub-pages, computed as
  `pathname.split("/").filter(Boolean).length > 1` (e.g. `/routes/123`, `/customers/456`). Calls
  `router.back()`. On top-level pages a spacer keeps the layout stable.
- **Page title** (`h1`) from `usePageTitle().title`.
- **Command palette trigger**: desktop shows a `Search…` pill with a `⌘K` kbd hint; below `md` it
  collapses to an icon-only search button. Both call `onOpenPalette`.
- **Notification bell** (`Bell`): red badge with `unreadCount` (shows `9+` when > 9). Opening the
  dropdown fires `markAllRead()`. Panel: header ("Notifications" + **Clear all**), a scrollable list
  (max `60vh`), and an empty state ("No notifications yet"). Each item shows a type-colored icon
  (urgent=danger/AlertTriangle, route=success/CheckCircle2, driver=brand/Truck, stock=warning/Package),
  title, description, and `timeAgo(timestamp)`. Unread rows tint `bg-brand-50/40`.
- **Avatar menu** (`Avatar` + username + `ChevronDown`): dropdown with **Profile & Settings**
  (→ `/settings`) and **Sign out** (→ `logout()`). Username hidden below `sm`.

### Notifications data — `apps/web/lib/hooks/useNotifications.ts`

- **Client-only, socket-fed, localStorage-persisted** (`rf_notifications`, cap **50**, newest first).
- Subscribes to the operator socket (`connectSocket(token)` using `OP_KEYS.accessToken`) and pushes a
  notification on: `order.urgent.placed` (urgent), `route.stop.completed` (route),
  `driver.status.updated` (driver), `inventory.low.stock` (stock).
- `unreadCount = notifications.filter(!read).length`; `markAllRead()` and `clear()` both persist.
- **Distinct from toasts:** `useRealtimeUpdates()` (mounted by the shell) also connects the socket and
  raises **toasts** + invalidates queries on a wider event set (`order.created`, `order.urgent.placed`,
  `order.statusChanged`, `route.stop.completed`, `driver.status.updated`, `inventory.low.stock`,
  `return.created`, `invoice.updated`, `creditNote.created`, plus a `connect_error` toast). So an
  urgent order both raises a toast (realtime) **and** appends a bell item (notifications) — two
  parallel systems (see 💡 Faster ways). `apps/web/lib/hooks/useRealtimeUpdates.ts`.

---

### Command palette — `apps/web/components/CommandPalette.tsx`

- **Open:** `useCommandPalette()` toggles on `⌘K` / `Ctrl+K` (`preventDefault`). Also opened from the
  header search buttons. `Esc` or backdrop click closes; portal-rendered overlay at `15vh` from top.
- **Two result kinds**, listed **search results first, then static commands**, grouped by section:
  - **Static commands** (`useStaticCommands`), `Navigate` group + `Actions` group:
    - Navigate → Dashboard (kw "home"), All Orders, Returns, Routes, Drivers, Customers, Products,
      Inventory, Suppliers, Invoices, Estimates, Credit Notes, Payments (`/finance/payments`),
      Expenses (`/finance/expenses`), Finance Overview (`/finance/dashboard`), Reports
      (`/finance/reports`), Analytics, Settings.
    - Actions → New Order (`/orders?action=new`), New Invoice (`/invoices/new`), New Route
      (`/routes/create`), New Customer (`/customers?action=new`), New Product (`/products?action=new`).
  - **Live search** (`useSearchResults`, operator-only, debounced ~280ms, `query.length >= 2`): fans out
    `Promise.allSettled` over `GET /customers`, `GET /orders`, `GET /invoices` (`search`, `limit:4`
    each) → grouped Customers / Orders / Invoices results linking to the entity detail page.
- **Role scoping:** for CUSTOMER, static items are filtered to Dashboard, All Orders, Returns,
  Invoices, Settings, New Order; for DRIVER to Dashboard, Routes, Settings. Non-operators get **no
  live search**.
- **Fuzzy match:** `fuzzyMatch` is a case-insensitive **AND-of-substrings** over
  `label + sublabel + keywords + group` — every space-separated query word must appear (not true
  fuzzy/typo-tolerant).
- **Keyboard:** `↑/↓` move `activeIndex`, `Enter` runs the active item's `action` (static) or pushes
  its `href` (search) then closes, `Esc` closes. Footer legend shows ↑↓ / ↵ / ESC.

---

### Keyboard shortcuts (g-sequences + `?`) — wired in `DashboardShell`

A single `window` `keydown` handler in `DashboardShell` implements a Gmail-style sequence map. It
**ignores** keystrokes while focus is in `INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`, and
ignores any keypress with `meta`/`ctrl`/`alt` held (except `?`). Sequence chars accumulate and reset
after **800ms** of inactivity.

| Keys | Action | Target |
|------|--------|--------|
| `g` `h` | Go to Dashboard | `/dashboard` |
| `g` `o` | Go to Orders | `/orders` |
| `g` `r` | Go to Routes | `/routes` |
| `g` `d` | Go to Drivers | `/drivers` |
| `g` `c` | Go to Customers | `/customers` |
| `g` `i` | Go to Invoices | `/invoices` |
| `g` `f` | Go to Finance | `/finance/dashboard` |
| `g` `s` | Go to Settings | `/settings` |
| `⌘K` / `Ctrl+K` | Open command palette | (via `useCommandPalette`) |
| `?` | Toggle keyboard-shortcuts help modal | (in-shell modal) |

- **Help modal** (`shortcutHelpOpen`): a centered card listing the shortcuts from the `SHORTCUTS`
  array (Dashboard, Orders, Routes, Drivers, Customers, Invoices, Finance, Settings, ⌘K, ?). Note the
  `SHORTCUTS` display array **omits `g h`→Dashboard label pairing quirk aside** it lists all g-jumps
  plus ⌘K + `?`. Closes on backdrop click or the X.
- **Caveat:** the g-sequences are **not role-gated** — a DRIVER pressing `g o` navigates to `/orders`,
  which then bounces back to `/dashboard` via `RouteGuard`. And `g d`→`/drivers` isn't reachable in the
  CUSTOMER/DRIVER nav at all (see 💡 Faster ways).

---

### Impersonation banner — `ImpersonationBanner`

- Renders **only** when `localStorage.impersonationToken` exists (super-admin impersonating a tenant).
- Full-width **red** bar above the header: "⚠️ Impersonating **{slug}** — acting as Tenant Admin",
  where slug comes from `localStorage.impersonationTenantSlug` (fallback `"unknown"`).
- **Exit impersonation** button: `clearTenantCookie()`, removes both impersonation localStorage keys,
  then `router.push("/admin/tenants")`.
- **The impersonation token is read-only** — the API blocks writes (locked by **CC-05** in
  `05-cross-cutting.spec.ts`, which asserts a POST with the impersonation token returns 403).

---

### Tenant branding injection — `apps/web/components/tenant-provider.tsx`

- Reads the JS-readable `tenant-slug` cookie, then `fetch`es
  `GET {NEXT_PUBLIC_API_URL}/public/tenants/{slug}/branding` with `cache: "no-store"`.
- Injects CSS custom properties on `<html>`: `--primary` (tenant `primaryColor` or default
  `#2563eb`), `--primary-foreground` (`#ffffff`), `--primary-rgb` (r,g,b for `rgba()` tinting). The
  sidebar/header consume `bg-brand-*` etc. backed by these vars; `TenantLogo` renders `logoUrl`/name.
- `refresh()` re-pulls after a logo/color change (Settings calls it) — **no hard reload**. Fetch
  failure is **non-fatal** (app renders with defaults).

### PWA install prompt — `apps/web/components/PwaInstallPrompt.tsx`

- Mounted by the shell as `<PwaInstallPrompt logoSrc="/logo.svg" accentClass="bg-brand-600 …" />`.
  Fixed bottom-center card. (The shell reserves `pb-24` on `<main>` so this never covers Save buttons.)
- Behavior: hides if already installed (`display-mode: standalone`); hides if dismissed this session
  (`sessionStorage["pwa-prompt-dismissed"]`); on **iOS** shows an "Add to Home Screen via Share" tip;
  on **Chrome/Android** listens for `beforeinstallprompt`, then shows an **Install** button that calls
  the deferred `prompt()`.
- **Separate richer variant** `apps/web/components/InstallAppButton.tsx` (`tenant`/`buyer` variants) is
  a **button → modal** with per-platform (iOS/Android/desktop) step-by-step instructions and benefit
  chips. Not mounted in the dashboard shell by default — it's an on-demand button used elsewhere
  (marketing/settings). Two overlapping install UIs exist (see 💡 Faster ways).

---

## Dashboard overview screen

#### Operator overview — `/dashboard`

- **File:** `apps/web/app/(dashboard)/dashboard/page.tsx`
- **Purpose:** The role-adaptive landing "Today" screen — greeting, KPI cards, order pipeline, finance
  insights, urgent orders, scheduled route runs, driver status, low stock, and recent orders. Content
  blocks show/hide by role (operator vs customer vs driver) and by a dual-role **mode switch**.
- **Shows** (operator view):
  - **Mode switcher** (top-right, only when `user.canActAsDriver && baseIsOperator`): a segmented
    **Operator | Driver** pill (persisted to `localStorage["rf-dashboard-view-mode"]`). Toggling it
    swaps the whole page between operator content and driver content — no navigation.
  - **Greeting** (operator only): "Good morning/afternoon/evening{, ownerName}!" (by local hour) +
    "Here's what's happening at {businessName} today." — `ownerName`/`businessName` from
    `GET /settings` (enabled only when `isOperator`). Right side: **Quick create** buttons — New Order
    (`/orders?action=new`), New Route (`/routes/create`), New Invoice (`/invoices/new`).
  - **KPI stat cards** (grid, up to 6, each a `Link` to a filtered list, each with a loading
    `StatSkeleton`):
    - **Today's Revenue** (operator) — `$` of `financeData.summaryTable.today.sales` → `/finance`.
    - **Overdue Invoices** (operator + customer) — `overdueData.meta.total` → `/invoices?status=OVERDUE`
      (danger ring when > 0).
    - **Active Orders** (all roles) — count of orders in `PENDING`/`CONFIRMED`/`OUT_FOR_DELIVERY` → `/orders`.
    - **Scheduled Routes** (operator + driver) — `routeRunsData.meta.total` → `/routes`.
    - **Active Drivers** (operator) — count of `status === "ACTIVE"` drivers → `/drivers` (success ring when > 0).
    - **Low Stock Items** (operator) — `lowStockData.meta.total` → `/products?lowStock=true` (warning ring when > 0).
  - **Order pipeline strip** (operator): 5 tappable cells — Pending / Confirmed / Out for Delivery /
    Delivered / Cancelled — each a count linking to `/orders?status={STATUS}`; nonzero cells get a tinted bg.
  - **Finance insights row** (operator, 2-col): **AR Aging** widget (`ArAgingWidget` — total
    outstanding + stacked bar + legend over buckets Current / 1–15d / 16–30d / 31–45d / 45d+, from
    `financeData.arAging`; link → `/finance/reports/ar-aging`) and **Overdue Invoices** action list
    (`OverdueInvoicesPanel` — up to 5, each row customer + `#invoiceNumber` + `{days}d overdue` +
    balance + View link; empty state "No overdue invoices").
  - **Middle row** (operator/driver): left 2/3 = **Urgent Orders** alert panel (danger-styled, up to 5
    `urgent` orders each with View Order; else an "All clear" success card) + **Scheduled Route Runs**
    `Card` with a `Table` (columns: Route Name, Driver, Status `Badge`, Stops `done/total`, Start Time;
    row click → `/routes/{id}`; empty state "No runs scheduled"). Right 1/3 (operator) = **Driver
    Status** `Card` (per-driver dot + contactName + plate/username + Active/Inactive badge) + **Low
    Stock** panel (`LowStockPanel` — per-product name + qty/threshold bar; "Not set" when stock null;
    empty state "All stock levels healthy").
  - **Recent Orders** `Card` (all roles): a `Table` of the 5 most recent orders (Order #, Customer,
    Items, Total, Status, Date) + "View all orders" link; empty state "No orders yet".
  - **Customer/driver quick-create** (when neither operator nor driver view active): a single
    **New Order** button.
- **Actions:** every KPI card, pipeline cell, and panel header is a link into the corresponding
  filtered list; Quick-create buttons open create flows; route-run rows push detail; mode switch
  toggles operator/driver content; urgent/overdue rows deep-link to the entity.
- **States:**
  - **Loading** — each block has its own skeleton (`StatSkeleton`, animated pulse rows/bars) keyed to
    its query's `isLoading` (finance, overdue, orders, runs, drivers, low stock all independent).
  - **Empty** — `EmptyState`/success cards per panel (no runs, no urgent orders, no overdue, healthy
    stock, no orders).
  - **Error** — Recent Orders shows an `ErrorBanner` ("Could not load recent orders.") on `isError`;
    other panels degrade to empty rather than error.
  - **Polling** — all queries use `refetchInterval: 30_000` (30s live refresh).
  - **Role-gating** — operator sees the full layout; **customer** sees Active Orders + Overdue
    Invoices + Recent Orders (no routes/drivers/stock/pipeline); **driver** sees Active Orders +
    Scheduled Routes + the route-runs list. `SUPER_ADMIN`/`TENANT_ADMIN`/unknown are treated as operator.
- **Data hooks:** `useOrders` (×3 — all/urgent/recent), `useRouteRuns({status:"SCHEDULED"})`,
  `useDrivers`, `useProducts({stockStatus:"LOW"})`, `useFinanceDashboard`, `useInvoices({status:"OVERDUE"})`,
  and a raw `useQuery(GET /settings)` for the greeting. Verified loading by **OP-03** in
  `apps/web/e2e/02-operator.spec.ts` ("KPI cards and recent orders visible").

---

## Key flows

- **Land + triage the day:** login → `AuthGuard` (force-password-change gate) → `/dashboard` → read
  KPI cards / pipeline / urgent-orders panel → click a KPI to jump to the filtered list (e.g. Overdue
  Invoices card → `/invoices?status=OVERDUE`).
- **Navigate anywhere fast:** press `⌘K` → type a page or entity name → `Enter` on a result → land on
  the page/entity; or use a `g`-sequence (`g o` → Orders) for muscle-memory jumps.
- **Reduced-role entry:** a CUSTOMER logs in → `getNavForRole` shows the 4-item customer nav; typing or
  linking to `/routes` triggers `RouteGuard` → `router.replace("/dashboard")`.
- **Collapse the rail on a laptop:** click **Collapse** → rail shrinks to icon-only, preference saved;
  groups render as flat icon links with tooltips.
- **Super-admin support session:** impersonate a tenant from `/admin/tenants` → red banner appears atop
  the operator shell → do read-only diagnosis → **Exit impersonation** → back to `/admin/tenants`.
- **Install the PWA:** on a phone the bottom prompt offers Install (Android) or Share→Add-to-Home
  (iOS); dismiss persists for the session.

## Business rules & edge cases — role path-gating

| Role | Nav tree | Client path allow-list (`RouteGuard`) | Palette scope | Dashboard content |
|------|----------|----------------------------------------|---------------|-------------------|
| `OPERATOR` | `OPERATOR_NAV` (+ My Routes if `canActAsDriver`, + Tobacco if addon) | none (full) | all static + live search | full operator layout |
| `TENANT_ADMIN` | `OPERATOR_NAV` (same as operator) | none (full) | all static + live search | operator layout |
| `SUPER_ADMIN` | `OPERATOR_NAV` (when in this shell) | none (full) | all static + live search | operator layout |
| `CUSTOMER` | `CUSTOMER_NAV` | `/dashboard`, `/orders`, `/returns`, `/invoices`, `/settings` | Dashboard/Orders/Returns/Invoices/Settings/New Order, **no live search** | Active Orders + Overdue + Recent Orders |
| `DRIVER` | `DRIVER_NAV` | `/dashboard`, `/routes`, `/settings` | Dashboard/Routes/Settings, no live search | Active Orders + Scheduled Routes + route-runs table |

Other rules:

- **Guard is client-side only** — a redirect for UX; the API enforces real authorization. Path match is
  prefix-based (`p` or `p + "/"`).
- **Force-password-change** is an absolute gate: any authenticated user with `forcePasswordChange` is
  pushed to `/change-password` and the dashboard renders `null`.
- **Dashboard-active-state exception:** the Dashboard leaf highlights only on exact `/dashboard`; all
  other leaves use `startsWith`.
- **Accordion never hides the active page:** the group containing the current route stays expanded even
  under the single-open rule.
- **Tobacco gating:** the Tobacco nav leaf and `/tobacco` are addon-gated (`useHasAddon`) and never
  shown to CUSTOMER/DRIVER.
- **Two socket subscriptions:** `useNotifications` and `useRealtimeUpdates` each call
  `connectSocket(token)` independently (bell items vs toasts).
- **Money display:** all `$` amounts on the overview are formatted with `toLocaleString` /
  `fmtMoney`; the app-wide rule (`invoice total = subtotal + tax`, boxed proration via `pricing.ts`)
  applies to the underlying data, not re-derived here.

## Relevant files

- `apps/web/app/(dashboard)/layout.tsx` — shell: nav trees (`OPERATOR_NAV`/`CUSTOMER_NAV`/`DRIVER_NAV`,
  `getNavForRole`), rail + drawer, `AuthGuard`, `RouteGuard` (`CUSTOMER_ALLOWED`/`DRIVER_ALLOWED`),
  `Header`, `ImpersonationBanner`, keyboard shortcuts + help modal, PWA + palette mounting.
- `apps/web/app/(dashboard)/dashboard/page.tsx` — operator/customer/driver overview.
- `apps/web/components/CommandPalette.tsx` — `⌘K` palette + `useCommandPalette` hook.
- `apps/web/lib/page-title-context.tsx` — page/tab title.
- `apps/web/lib/hooks/useNotifications.ts` — socket-fed, localStorage-persisted bell notifications.
- `apps/web/lib/hooks/useRealtimeUpdates.ts` — socket → toast + query invalidation.
- `apps/web/components/tenant-provider.tsx` — branding CSS-var injection (`useTenant`).
- `apps/web/components/PwaInstallPrompt.tsx` — bottom install banner (mounted in shell).
- `apps/web/components/InstallAppButton.tsx` — richer install button+modal (on-demand, not in shell).
- `apps/web/lib/api/tobacco.ts` — `useHasAddon`, `TOBACCO_ADDON`.
- Supporting hooks: `apps/web/lib/api/{orders,routes,drivers,products,finance,invoices}.ts`.
- Specs: `apps/web/e2e/02-operator.spec.ts` (OP-03 dashboard, OP-04..22 nav destinations),
  `03-customer.spec.ts` (CU-03/04 role gating), `05-cross-cutting.spec.ts` (CC-01/04/05/09 guards +
  impersonation read-only).

---

## 💡 Faster ways

> Suggestions for the redesign — **not** current behavior. Quarantined per the inventory rules.

1. **Surface keyboard shortcuts discoverably.** The `g`-sequences and `⌘K` are only findable by
   pressing `?` — there's no visible hint anywhere except the command-palette pill's `⌘K` kbd. Consider
   a persistent "keyboard" affordance in the header/footer, `?` hints in tooltips, or a first-run coach
   mark. The help modal already exists; just make its existence obvious.
2. **Role-gate the shortcuts + palette to match the nav.** `g d`→`/drivers` and `g o`→`/orders` fire
   for every role, then bounce off `RouteGuard` (jarring for CUSTOMER/DRIVER). Derive the shortcut map
   and palette static items from the same `getNavForRole` tree so unavailable destinations simply don't
   trigger.
3. **Unify the two notification/socket systems.** `useNotifications` (bell, persisted) and
   `useRealtimeUpdates` (toasts + invalidation) both open their own socket and duplicate event
   handling (urgent orders appear in both). One socket subscription feeding one event bus — with each
   consumer choosing toast vs bell vs invalidate — removes drift (e.g. `return.created` toasts but
   never lands in the bell; `order.created` invalidates but isn't a bell item).
4. **Consolidate the two PWA install UIs.** `PwaInstallPrompt` (banner) and `InstallAppButton`
   (button+modal, tenant/buyer variants) implement `beforeinstallprompt` twice with different copy and
   styling. Pick one component with an inline-banner and a full-modal mode.
5. **Make the collapsed-rail accordion states legible.** In the collapsed rail, groups flatten to
   icon-only children with no group affordance — a Warehouse "Inventory" icon and a Dispatch "Overview"
   icon (both `LayoutDashboard`) can collide visually. Consider distinct icons or a hover fly-out group
   menu on the collapsed rail.
6. **Single source of truth for "quick create."** New-Order/Route/Invoice/Customer/Product live in
   three places (dashboard Quick-create buttons, palette Actions, and per-list "New" buttons) with
   subtly different targets (`/orders?action=new` vs `/invoices/new`). Centralize the create-route map.
7. **Dashboard data fan-out.** The overview fires ~8 polling queries every 30s (all/urgent/recent
   orders, runs, drivers, low stock, finance, overdue). A single `/dashboard/summary` endpoint (mobile
   aggregates client-side too — worth aligning) would cut request volume and jitter.
