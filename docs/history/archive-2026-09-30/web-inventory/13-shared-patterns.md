# 13 — Shared UX Patterns & Component Inventory

> **This file is the redesign's non-negotiables checklist.** Everything below is a cross-cutting
> behavior that lives _once_ and is reused across many screens. It documents the little features
> that make RouteFlow feel fast for a wholesale operator running orders/invoices all day. The
> redesign owns the visuals — but every **behavior**, **keyboard affordance**, and **money rule**
> here must survive. The completeness guarantee: if a pattern is listed here, a mockup that drops
> it is wrong.

See [`README.md`](README.md) for conventions, personas, the app-wide model (multi-tenancy, RBAC,
token namespaces, impersonation), and the design-inconsistency catalogue that this redesign
resolves.

---

## 1. UX Micro-Features

Each entry: **what it does · where it lives / who uses it · why it matters.**

### 1.1 Barcode scanning (dual-mode)

**File:** `apps/web/components/BarcodeScannerButton.tsx`

- **What.** Two independent scan paths behind one component:
  1. **USB / physical scanner (no camera).** When an `inputRef` is passed, it attaches a `keydown`
     listener to that input. A hardware scanner types characters extremely fast then presses Enter;
     the handler treats a sequence of ≥ 6 chars where each keystroke arrived < 200 ms apart, capped
     by an Enter within 150 ms of the last char, as a **scan** → calls `onScan(sequence)` and
     `preventDefault()`s the Enter. Normal human typing (gaps > 200 ms) resets the buffer, so the
     same field still works as a plain text input.
  2. **Webcam overlay.** The camera-icon button opens a fullscreen `z-[9999]` overlay that lazy-
     imports `@zxing/browser` `BrowserMultiFormatReader`, enumerates video devices (prefers the
     **last** device — usually the rear camera), and decodes live. On a successful decode it calls
     `onScan`, stops the reader, and closes. A dashed guide box + "Align barcode within the box"
     hint frames the target. Errors (permission denied, no camera) log and close silently.
- **Where.** Order builder (`/orders` new-order modal), invoice builder (`/invoices/new`),
  `InlineCreateProductModal` (SKU field **and** "Variant of" parent lookup), Quick Restock, Scan
  Invoice.
- **Why it matters.** The whole warehouse/counter workflow is scan-driven. The USB path means an
  operator with a $30 handheld scanner never touches the mouse; the webcam path is the phone/laptop
  fallback. Losing either breaks the primary data-entry mode.

### 1.2 Just-scanned line auto-scroll

**File:** `apps/web/app/(dashboard)/invoices/new/page.tsx` (mirrored in the order builder)

- **What.** Each line row registers itself in a `rowRefs` Map by key. After a scan adds/increments a
  line, `setScrollToKey(key)` fires an effect that calls
  `rowRefs.current.get(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" })`. Scanning an
  item already on the invoice **increments its qty by one box** (or +1 unit) instead of duplicating,
  and scrolls to that existing row.
- **Why it matters.** Rapid scanning of a 40-line order pushes new rows off-screen; auto-scroll keeps
  the just-touched line visible so the operator sees the qty tick up and trusts the scan landed.

### 1.3 Per-customer price memory ("special price")

**File:** `apps/web/app/(dashboard)/invoices/new/page.tsx` — `priceMap` + `addProductFromCatalog`

- **What.** On customer select, `useCustomerPrices(customer.id)` builds a `priceMap`
  (`productId → negotiated unitPrice`). When a product is added (scan or picker), the line's
  `unitPrice` = special price if one exists, else the product list price. When special, the row also
  stamps `regularPrice` (list) + `isSpecialPrice: true` so the UI can show the strikethrough
  original. Boxed products seed `boxes: 1, pieces: 0` and qty = `unitsPerBox`.
- **Why it matters.** Wholesale runs on per-customer negotiated pricing. The operator must not
  re-key a price they already agreed months ago. This is the "price carries forward" behavior from
  the per-order override feature.

### 1.4 URL-backed filters

**File:** `apps/web/lib/hooks/useUrlFilters.ts`

- **What.** `useUrlFilters(defaults)` → `[state, setFilter, clearAll]`. State is read _from_ the URL
  query string (falling back to defaults), so a filtered list is **shareable and refresh-safe**.
  `setFilter` writes via `router.replace(..., { scroll: false })`; booleans serialize to `"1"`,
  empty/`false`/`undefined` **delete** the param. **Every `setFilter` and `clearAll` also deletes
  `page`** — changing a filter always resets pagination to page 1. `clearAll` removes only the known
  filter keys, preserving unrelated params (e.g. `?action=new`).
- **Where.** Orders, and any list adopting it (uneven today — see catalogue #7).
- **Why it matters.** Filters that vanish on refresh or can't be linked to a teammate are a
  daily-driver annoyance. This makes list state a first-class URL citizen.

### 1.5 Saved views (filter presets)

**File:** `apps/web/app/(dashboard)/orders/page.tsx` — `SAVED_VIEWS`

- **What.** A row of pill chips: **All · Pending · Confirmed · Out for Delivery · Urgent ·
  Delivered · Cancelled.** Each maps to a filter object. `applyView` calls `clearFilters()` then
  `setFilter` for each preset key. `activeSavedView` is derived by comparing current URL filters to
  each preset, so the matching chip highlights (`bg-brand-600 text-white`) even after a refresh or a
  hand-typed URL.
- **Why it matters.** One click to the operator's most-used slices of the order queue; the derived
  active state means the chip row and the filter bar never disagree.

### 1.6 Bulk selection + destructive confirm

**Files:** `apps/web/app/(dashboard)/orders/page.tsx` (bulk cancel/delete),
`apps/web/components/inventory/StockCountBulkBar.tsx` (stock count)

- **What (orders).** A **Select** toggle enters select mode (row checkboxes appear, column count
  shifts). A contextual bar shows `{n} selected` with **Deselect all**, **Cancel {n}**, and
  **Delete {n}**. Delete uses **inline two-step confirm** ("Delete N orders? → Confirm Delete / No")
  rather than a modal. Bulk delete reports partial success ("X deleted, Y failed — only
  PENDING/CANCELLED orders can be deleted") via toast.
- **What (stock count).** `StockCountBulkBar` is a **sticky** (`sticky top-0`) bar that appears only
  when ≥ 2 rows are selected. Actions: set mode (**Add to existing** / **Replace count**), **Set
  qty** (number input, Enter to apply), **Clear**, **Remove rows**.
- **Why it matters.** Managing 50 orders one-by-one is untenable. The inline confirm and
  partial-success toast prevent accidental destruction while keeping the flow fast. **Note:** these
  two bars are visually different implementations of the same idea — the redesign should unify them.

### 1.7 Toasts

**File:** `packages/ui/src/web/Toast.tsx` (Radix Toast)

- **What.** `useToast().toast({ title, description?, variant?, duration? })`. Variants
  `success | error | warning | info` (default `info`) each map to an icon + tinted bg
  (`success-bg`, `danger-bg`, etc.). Auto-dismiss after **4000 ms** default (`duration` overrides).
  Swipe **right** to dismiss (`swipeDirection="right"`); an X close button; slide-in-from-top /
  slide-out-to-right animations. **Viewport is fixed bottom-right** (`bottom-4 right-4`, `w-96`,
  `z-[100]`), stacking vertically. Provider mounted once in the dashboard shell.
- **Why it matters.** Every mutation (create/update/delete/scan-miss) and realtime event surfaces
  here. Placement, auto-dismiss, and swipe are muscle memory — the redesign must keep bottom-right +
  swipe-right.

### 1.8 Tables (TanStack) + sortable headers

**Files:** `packages/ui/src/web/Table.tsx`, `apps/web/components/SortableTh.tsx`

- **What (Table).** Generic `Table<TData>` over `@tanstack/react-table` with client sorting.
  `isLoading` renders **5 skeleton rows** (`animate-pulse` bars). Empty → a full-width centered
  `emptyState` node (or "No data available"). `onRowClick` makes rows a hover-highlighted pointer
  target. Sort chevron is **invisible by default, fades in on column hover, stays solid on the
  active sort** (`ChevronsUpDown` idle → `ChevronUp`/`ChevronDown` active); `aria-sort` set for a11y.
- **What (SortableTh).** The same header affordance for **raw `<table>` markup** paired with
  `useSortableData` (many pages hand-roll tables rather than use `Table`). Same hover/active chevron
  cycle (asc → desc → unsorted), `align="right"` for numeric/currency columns.
- **Why it matters.** Skeletons prevent layout jank on slow loads; the "clean until hovered" sort
  chevron keeps dense operator tables uncluttered. **Fragmentation:** some lists use `Table`, others
  use `SortableTh` + raw markup, others neither — the redesign should standardize one table system.

### 1.9 Empty states

**File:** `packages/ui/src/web/EmptyState.tsx`

- **What.** `<EmptyState variant title description? action? />` with on-brand SVG illustrations keyed
  by content type: `orders | routes | customers | products | invoices | drivers | returns | inbox |
data | custom`. Centered illustration + title + description + optional action button (usually the
  primary "create" CTA).
- **Why it matters.** A good empty state teaches the next action ("No orders yet → New Order").
  **Fragmentation:** present on some list pages, absent on others (catalogue #7) — a redesign
  non-goal is to make every list use it.

### 1.10 Command palette (Cmd/Ctrl+K)

**File:** `apps/web/components/CommandPalette.tsx`

- **What.** `useCommandPalette()` toggles on **⌘K / Ctrl+K**. A centered portal modal with:
  **Navigate** commands (~18 routes) + **Actions** ("New Order/Invoice/Route/Customer/Product") that
  are **role-filtered** (CUSTOMER and DRIVER see a reduced set); plus **live search** across
  customers/orders/invoices (debounced 280 ms, `Promise.allSettled` of 3 endpoints, min 2 chars,
  spinner while loading). Full keyboard nav: ↑↓ move, Enter select, Esc close; mouse hover syncs the
  active row. Footer legend shows ↑↓ / ↵ / ESC.
- **Why it matters.** Power-user jump-to-anything without leaving the keyboard. Search results turn
  it into global find, not just a launcher.

### 1.11 Keyboard shortcuts (g-sequences + `?`)

**File:** `apps/web/app/(dashboard)/layout.tsx`

- **What.** Global `keydown` listener (ignored while typing in input/textarea/select/contenteditable,
  and when ⌘/Ctrl/Alt held). **g-then-letter** sequences (800 ms window) navigate:
  `gh`→Dashboard, `go`→Orders, `gr`→Routes, `gd`→Drivers, `gc`→Customers, `gi`→Invoices,
  `gf`→Finance, `gs`→Settings. **`?`** toggles a shortcuts help modal (also lists ⌘K). Documented in
  detail in `03-operator-shell.md`.
- **Why it matters.** Gmail-style nav is the fastest way around for daily operators. The `?` help is
  the discoverability entry point (see 💡 Faster ways — it could be more discoverable).

### 1.12 Realtime updates

**Files:** `apps/web/lib/hooks/useRealtimeUpdates.ts`, `apps/web/lib/socket.ts`

- **What.** On mount (operator token present), connects a singleton Socket.io client
  (`socket.ts`: websocket→polling transports, reconnect ×5 @1 s, singleton guard). Subscribes to
  9 domain events → invalidates the matching TanStack Query keys so lists/detail refetch, and fires
  a **toast** for the human-relevant ones. `connect_error` shows an error toast ("Live updates may
  be unavailable"). See §4 for the full map. Cleans up all listeners + disconnects on unmount.
- **Why it matters.** A dispatcher watching the order queue sees new/urgent orders appear without
  refreshing. The toast on urgent orders / low stock / driver status is an ops alert channel.

### 1.13 Export & multi-channel send

**Files:** `apps/web/lib/export.ts`, `apps/web/lib/report-export.ts`,
`apps/web/lib/fetch-pdf-blob.ts`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx`,
`apps/web/app/(dashboard)/orders/[id]/page.tsx`

- **CSV export.** `downloadCsv(filename, headers, rows)` — RFC-4180 quoting (quotes fields containing
  `" , \n \r`, doubles embedded quotes), `\r\n` line endings, `text/csv;charset=utf-8`, triggers an
  `<a download>` click and revokes the object URL. `csvDate()` truncates ISO → `YYYY-MM-DD`.
  `report-export.ts` is a near-duplicate (`exportReportCSV`, `\n` endings, appends `.csv`) plus
  `printReport()` = `window.print()`. **Neither prepends a UTF-8 BOM today** (a known gap for Excel
  UTF-8 detection — see 💡 Faster ways).
- **PDF fetch.** `fetchPdfBlob(url, authClient)` compares the URL origin to the auth client's
  **runtime** `baseURL`: same-origin (our API) → auth'd client (attaches Bearer, avoids the 401 bug
  from comparing against build-time env); different origin (R2/S3 presigned) → bare axios, no auth.
- **Multi-channel send** (invoice & order detail). A share sheet offers **Send via WhatsApp**
  (`https://wa.me/<digits>?text=<msg>`, shown when a phone exists), **Send via Email** (button →
  API send to `customerEmail`), and **Send via Text** (`sms:<phone>?body=<msg>`). Channels appear
  conditionally on available contact info.
- **Why it matters.** Small wholesalers send invoices however the customer prefers — WhatsApp is
  huge in many markets. CSV export feeds their accountant/spreadsheets. These are real revenue-
  adjacent flows, not nice-to-haves.

### 1.14 Inline-create modals (create-without-leaving)

**Files:** `apps/web/components/InlineCreateProductModal.tsx`,
`InlineCreateSupplierModal.tsx`, `SearchableProductPicker.tsx`, `SupplierSelect.tsx`

- **What.** When a needed record doesn't exist mid-flow, create it in a stacked modal (`z-[200]`, so
  it sits above the order/invoice/scan dialog) and **auto-select** it in the parent via
  `onCreated(record)`. `InlineCreateProductModal` pre-fills name from a typed search term and SKU
  from a scanned barcode, supports variant creation (parent picker + "will appear as
  Parent · Variant" preview), and can resolve a scanned barcode → parent product.
  `SupplierSelect` is a `<select>` + "**+ New**" button wrapping `InlineCreateSupplierModal`
  (reused across Scan Invoice, Quick Restock, vendor bill, expense create, bill edit).
- **Why it matters.** An operator taking a phone order for a brand-new product/supplier can't be
  bounced to a different page and lose their cart. Inline-create-and-select is the whole reason the
  order flow doesn't stall.

### 1.15 Searchable pickers & comboboxes

**Files:** `SearchableProductPicker.tsx`, `UnitCombobox.tsx`, `AddressAutocomplete.tsx`,
`apps/web/lib/hooks/useDebounce.ts`

- **SearchableProductPicker.** Replaces native `<select>` for product lookup (native selects clip in
  modals and don't type-search reliably). Filters by **name AND SKU**, arrow/enter/escape nav, click-
  outside close, clear button, result count header, "Inactive" badge, 200-item safety cap,
  `excludeIds` support.
- **UnitCombobox.** Free-text unit field with a curated suggestion list (`COMMON_UNITS`: each, case,
  box, kg, L, …) merged with catalog units; Enter on a single match selects it, otherwise keeps the
  typed value ("New unit type" hint) — so units are both **standardized and open-ended**.
- **AddressAutocomplete.** Debounced (300 ms) calls to the backend Places proxy
  (`/public/places/autocomplete`), Mapbox parts embedded (no details round-trip) with a details
  fallback, `onAddressSelect(parts)` fills street/city/state/zip. Full keyboard + a11y
  (`role=combobox`, `aria-expanded/-invalid`), loading spinner in the field.
- **useDebounce.** Generic `useDebounce(value, delay=300)` used by search inputs across the app.
- **Why it matters.** These are the friction-removers on every form — type-to-search, keyboard nav,
  and address autofill turn slow dropdowns into fast entry.

### 1.16 Forms (react-hook-form + zod)

- **What.** Web is the golden reference for DTOs; forms use **react-hook-form + zod** resolvers with
  `class-validator`-mirroring schemas (the API validates the same shape). Inputs share the token
  classes (`border-surface-border`, `focus:ring-brand-500`, `text-danger` errors). Required fields
  marked with `*` (`text-danger`). Buttons expose a `loading` state that disables + spins during
  mutations.
- **Why it matters.** Consistent validation UX and a single source of truth for field shape between
  web and mobile.

### 1.17 ConfirmDialog

**File:** `apps/web/components/ConfirmDialog.tsx`

- **What.** Thin wrapper over `Modal` for yes/no destructive confirms: `AlertTriangle` icon (red for
  `danger`, amber for `secondary`), title, description (default "This action cannot be undone…"),
  Cancel + confirm button with `loading` state. `max-w-sm`.
- **Why it matters.** The standard guard on single-item destructive actions (the orders bulk-delete
  uses an inline variant instead — another spot to unify).

### 1.18 Tenant branding injection

**File:** `apps/web/components/tenant-provider.tsx`

- **What.** Reads the `tenant-slug` cookie, fetches `/public/tenants/{slug}/branding`
  (`cache: "no-store"`), and injects `--primary`, `--primary-foreground`, `--primary-rgb` CSS vars
  onto `<html>`. Tailwind's `primary` color and `bg-brand-*`/rgba tints resolve from these vars.
  `refresh()` re-pulls after a settings/logo change without a hard reload. Fully **non-fatal** if the
  fetch fails (falls back to `#2563eb`).
- **Why it matters.** Every tenant's dashboard wears their brand color/logo. The redesign's token
  system must keep a single runtime-overridable primary hook.

### 1.19 PWA install

**Files:** `apps/web/components/PwaInstallPrompt.tsx`, `apps/web/components/InstallAppButton.tsx`

- **What.** `PwaInstallPrompt` — a bottom-center banner on `beforeinstallprompt` (Chrome/Android) or
  an iOS "Share → Add to Home Screen" tip; dismiss persists in `sessionStorage`; hidden when already
  standalone. `InstallAppButton` — an explicit "Get the App" button opening a platform-aware modal
  (iOS steps / Android one-tap install / desktop guidance), themed per `tenant` or `buyer` variant.
- **Why it matters.** Operators and buyers run this like a native app on phones; the install prompt
  is the on-ramp.

---

## 2. Shared Component Inventory

Everything exported from `packages/ui/src/web/` (via `index.ts`), plus the app-level shared
components documented above. Redesign must provide an equivalent for each.

### 2a. `packages/ui/src/web/` (the shared kit)

| Component                              | File                | Purpose (one line)                                                                                                                          |
| -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                               | `Button.tsx`        | Primary/secondary/danger/ghost variants, sizes, `loading` spinner, `leftIcon`/`rightIcon`.                                                  |
| `Badge`                                | `Badge.tsx`         | Status pills — 5 tone variants + a large `BadgeStatus` enum mapping every domain status (order/invoice/return/estimate/payment) to a color. |
| `Card`                                 | `Card.tsx`          | Surface container with border/`shadow-card` — the base panel primitive.                                                                     |
| `Input`                                | `Input.tsx`         | Text input with label/error/hint, token focus ring.                                                                                         |
| `PasswordInput`                        | `PasswordInput.tsx` | Input with show/hide toggle.                                                                                                                |
| `Textarea`                             | `Textarea.tsx`      | Multi-line input, same styling as `Input`.                                                                                                  |
| `Select`                               | `Select.tsx`        | Styled native `<select>` with `SelectOption[]`.                                                                                             |
| `Modal`                                | `Modal.tsx`         | Dialog primitive (backdrop, header, `footer` slot, `className` width) — base for `ConfirmDialog` and most dialogs.                          |
| `Table`                                | `Table.tsx`         | TanStack table: client sort, 5 skeleton rows, empty state, `onRowClick`.                                                                    |
| `StatCard`                             | `StatCard.tsx`      | KPI/metric tile (label + value + optional delta/icon) for dashboards.                                                                       |
| `Avatar`                               | `Avatar.tsx`        | User/tenant avatar with initials fallback, sizes.                                                                                           |
| `Toast` / `ToastProvider` / `useToast` | `Toast.tsx`         | Bottom-right Radix toasts, 4 variants, auto-dismiss, swipe-right.                                                                           |
| `PageHeader`                           | `PageHeader.tsx`    | Page title + subtitle + actions slot — the top-of-page header pattern.                                                                      |
| `Tabs`                                 | `Tabs.tsx`          | Tab strip + panels.                                                                                                                         |
| `EmptyState`                           | `EmptyState.tsx`    | Illustrated empty states keyed by content type.                                                                                             |
| Illustrations                          | `illustrations.tsx` | On-brand SVGs: NoOrders/NoRoutes/NoCustomers/NoProducts/NoInvoices/NoDrivers/NoReturns/InboxZero/NoData.                                    |
| `cn`, `mergeRefs`                      | `utils.ts`          | `clsx`+`tailwind-merge` class combiner; ref merge helper.                                                                                   |

### 2b. App-level shared components (`apps/web/components/`)

| Component                              | File                              | Purpose                                                    |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `BarcodeScannerButton`                 | `BarcodeScannerButton.tsx`        | USB fast-sequence + webcam @zxing scanner.                 |
| `CommandPalette` / `useCommandPalette` | `CommandPalette.tsx`              | ⌘K launcher + live search.                                 |
| `ConfirmDialog`                        | `ConfirmDialog.tsx`               | Destructive yes/no confirm over `Modal`.                   |
| `InlineCreateProductModal`             | `InlineCreateProductModal.tsx`    | Create+auto-select a product mid-flow (variants, barcode). |
| `InlineCreateSupplierModal`            | `InlineCreateSupplierModal.tsx`   | Create+auto-select a supplier mid-flow.                    |
| `SupplierSelect`                       | `SupplierSelect.tsx`              | Supplier dropdown + "+ New" inline-create.                 |
| `SearchableProductPicker`              | `SearchableProductPicker.tsx`     | Searchable product combobox (name+SKU).                    |
| `UnitCombobox`                         | `UnitCombobox.tsx`                | Standardized-but-open unit field.                          |
| `AddressAutocomplete`                  | `AddressAutocomplete.tsx`         | Debounced Places-proxy address autofill.                   |
| `TenantProvider` / `useTenant`         | `tenant-provider.tsx`             | Fetches + injects tenant brand CSS vars.                   |
| `TenantLogo`                           | `TenantLogo.tsx`                  | Renders the tenant logo (with fallback).                   |
| `PwaInstallPrompt`                     | `PwaInstallPrompt.tsx`            | Auto install banner (Android/iOS).                         |
| `InstallAppButton`                     | `InstallAppButton.tsx`            | Explicit "Get the App" install modal.                      |
| `StockCountBulkBar`                    | `inventory/StockCountBulkBar.tsx` | Sticky bulk-edit bar for stock counting.                   |
| `SortableTh`                           | `SortableTh.tsx`                  | Sortable `<th>` for raw tables + `useSortableData`.        |

### 2c. Shared hooks / libs

| Hook / lib                        | File                              | Purpose                                                   |
| --------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `useUrlFilters`                   | `lib/hooks/useUrlFilters.ts`      | URL-backed filter state + page reset + clearAll.          |
| `useRealtimeUpdates`              | `lib/hooks/useRealtimeUpdates.ts` | Socket.io → query invalidation + toasts.                  |
| `useDebounce`                     | `lib/hooks/useDebounce.ts`        | Generic value debounce.                                   |
| `useSortableData`                 | `lib/use-sortable-data.ts`        | Client sort state for raw tables (pairs w/ `SortableTh`). |
| `socket`                          | `lib/socket.ts`                   | Singleton Socket.io connect/disconnect.                   |
| `downloadCsv` / `csvDate`         | `lib/export.ts`                   | CSV builder + download.                                   |
| `exportReportCSV` / `printReport` | `lib/report-export.ts`            | Report CSV + print.                                       |
| `fetchPdfBlob`                    | `lib/fetch-pdf-blob.ts`           | Auth-aware PDF/blob fetch.                                |
| `pricing` helpers                 | `lib/pricing.ts`                  | Money math (see §5).                                      |

---

## 3. Current Design Tokens (and the fragmentation)

Tokens exist in **three overlapping places** today — the redesign must collapse these into one
system. Full inconsistency catalogue is in `README.md` (#3, #7); this is what's actually defined.

### 3.1 Where tokens live

- `packages/config/tailwind.config.ts` — the **preset** (shared across apps). Full color scales,
  type scale, radius, shadows.
- `apps/web/tailwind.config.ts` — extends the preset; **fills in brand-scale gaps** (preset only
  ships 50/100/500/700/900; web adds 200/300/400/600/800), adds `primary` = `var(--primary)`,
  `buyer-*`, `canvas-*`, and a **safelist** for dynamically-composed brand/canvas classes.
- `apps/web/app/globals.css` — CSS custom properties (`:root`) for surface/status/primary, consumed
  by both Tailwind (`var(--primary)`) and raw CSS.

### 3.2 Color scales

- **`brand`** (blue) — `50 #eff6ff … 500 #3b82f6 … 600 #2563eb … 900 #1e3a8a`. The operator primary.
- **`primary`** — `var(--primary, #2563eb)` + `--primary-foreground` — **runtime tenant override**
  (see §1.18). This is the branded accent; `brand-*` is the static blue.
- **`buyer`** (emerald) — `50 #ecfdf5 … 500 #10b981 … 900 #064e3b`. The B2B buyer portal's palette.
- **`navy`** — `#1B3A5C` (DEFAULT, = `--foreground` text) + `light #2563EB`.
- **`canvas`** (dark) — `#0f1b2d / mid #152238 / light #1a2d4a`. Hero/CTA dark sections.
- **`surface`** — `DEFAULT #fff / raised #f8fafc / border #e2e8f0`. The neutral chrome.
- **Status** — `success #16a34a`/bg `#dcfce7`, `warning #d97706`/bg `#fef3c7`,
  `danger #dc2626`/bg `#fee2e2`, `info #0284c7`/bg `#e0f2fe` (info in CSS only).

### 3.3 Typography

Semantic 6-step scale (mirrors mobile `typography.ts`), defined **twice** (preset + web config):
`display 2rem/700` · `heading-1 1.5rem/600` · `heading-2 1.25rem/600` · `body 1rem` ·
`body-sm 0.875rem` · `label 0.875rem/500` · `caption 0.75rem`. Font: **Inter** via `--font-inter`.

### 3.4 Radius & shadows

- Radius: `sm 4px · DEFAULT 8px · lg 12px · xl 16px · full 9999px`.
- Shadow: `card` (subtle), `dropdown` (medium), `modal` (large). `tailwindcss-animate` plugin
  provides the toast/enter-exit animations.

### 3.5 Dark mode — **NOT implemented**

`globals.css` ships a **commented-out** `.dark` block with the intended dark values
(`--background #0f1b2d`, etc.), gated on `class="dark"` on `<html>` — never activated. There is no
theme toggle. The redesign can choose to implement it, but today the app is light-only.

### 3.6 The fragmentation to fix

- Brand scale is split across two config files (preset gaps patched in the app config + a safelist).
- Type scale is duplicated preset↔app.
- Four competing palettes coexist (dashboard blue, marketing teal/cream scoped CSS, buyer emerald,
  hardcoded per-auth-screen colors). Auth screens are fully hardcoded (README catalogue #1/#3).
- `brand` vs `primary` (static vs tenant-runtime) is a real distinction the redesign must preserve,
  not merge away.

---

## 4. Realtime Event Map

`useRealtimeUpdates.ts` — socket event → query keys invalidated → toast fired.

| Socket event            | Invalidates query keys              | Toast? | Toast content / variant                                                               |
| ----------------------- | ----------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `connect_error`         | —                                   | ✅     | "Real-time connection failed" / **error**                                             |
| `order.created`         | `orders`, `dashboard`               | ✅     | "🚨 Urgent order placed" (**error**) or "New order placed" — `{customer} — order {n}` |
| `order.urgent.placed`   | `orders`                            | ✅     | "Urgent order placed" / **error** — `{customer} — order {n}`                          |
| `order.statusChanged`   | `orders`, `orders/{id}`             | —      | (silent refetch)                                                                      |
| `route.stop.completed`  | `routes`, `orders`                  | —      | (silent refetch)                                                                      |
| `driver.status.updated` | `drivers`, `routes`                 | ✅     | "Driver status changed" — `{driver} is now {status}`                                  |
| `inventory.low.stock`   | `products`, `inventory`             | ✅     | "Low stock alert" / **error** — `{product} — only {n} units remaining`                |
| `return.created`        | `returns`                           | ✅     | "New return submitted" — `{customer} — reason: {reason}`                              |
| `invoice.updated`       | `invoices`, `invoices/{id}`         | —      | (silent refetch)                                                                      |
| `creditNote.created`    | `credit-notes`, `credit-notes/{id}` | —      | (silent refetch)                                                                      |

Transport: `websocket`→`polling`, JWT in `auth.token`, singleton, reconnect ×5 @1 s. Only connects
when an operator access token is present.

---

## 5. Money-Math Invariants (hard rules)

All money flows through `apps/web/lib/pricing.ts` (mirror of `apps/api/src/common/pricing.ts` and
`apps/mobile/lib/pricing.ts` — **keep all three in sync**). Helpers: `computeLineSubtotal` (boxed
proration), `normalizeBoxesPieces` (integer boxes/pieces + rollover), `roundMoney` (cents).

These are **locked by** `apps/web/e2e/06-critical-paths.spec.ts` (CP-01…CP-10). Any redesign must
keep passing them:

- **CP-01 / CP-02 / CP-09** — every displayed amount on invoice/order/product lists matches
  `^\$[\d,]+\.\d{2}$` — i.e. **always `$X.XX`**, no float artifacts (`$16.467000000000002`).
- **CP-03 / CP-10** — invoice **total = subtotal + tax** within ±$0.01, at both UI and API layers.
- **CP-04 / CP-05** — API money fields (`subtotal|total|tax|amount|price|balance`) carry **≤ 2
  decimal places** (deep-scans response JSON).
- **CP-06 / CP-07** — order-detail and finance-dashboard amounts are all well-formed `$X.XX`.
- **CP-08** — buyer portal loads without server error (buyer-facing amounts sane).
- **Regression origin:** the "220 × 2 = 420" bug — a boxed line re-derived as `qty * unitPrice`
  instead of prorating. **Never re-derive `qty * unitPrice` for a boxed line** (over-charges by
  `unitsPerBox`). **Round every monetary write.**
- **Line-discount convention:** an override is stored as net `unitPrice` + `originalPrice`
  (strikethrough) + `discount: 0`. **Never re-derive discount from originalPrice** (double-counts).

---

## 6. NON-NEGOTIABLES CHECKLIST

The redesign MUST preserve every one of these behaviors (visuals may change; behavior may not):

- **Barcode scanning both ways** — USB fast-keystroke auto-submit (≥ 6 chars, < 200 ms/char, Enter
  within 150 ms) _and_ webcam @zxing overlay, on every scan surface.
- **Just-scanned line auto-scrolls into view**, and re-scanning an existing line increments its qty
  instead of duplicating.
- **Per-customer price memory** — negotiated `unitPrice` auto-fills on add; special price shows the
  list price struck through; price carries forward.
- **Inline per-line editing** on the order/invoice builders (qty as boxes+pieces, unit price,
  discount) with rounded money math.
- **Saved views** (Orders filter-preset chips) with derived active-chip highlighting.
- **URL-backed filter state** — filters live in the query string, are shareable/refresh-safe, and
  reset pagination to page 1 on change.
- **Command palette on ⌘K / Ctrl+K** with role-filtered nav/actions + live entity search, full
  keyboard navigation.
- **g-sequence keyboard shortcuts** (`gh/go/gr/gd/gc/gi/gf/gs`) + **`?`** help modal.
- **Toasts bottom-right, swipe-right to dismiss, 4 s auto-dismiss**, 4 semantic variants.
- **Skeleton loading rows** on tables (no layout jank on load).
- **Illustrated empty states** on every list/detail — and applied _everywhere_, not just some pages.
- **Sortable headers** with the invisible-until-hover / solid-when-active chevron cycle (asc → desc
  → unsorted).
- **Realtime updates** — Socket.io invalidates queries live and toasts urgent orders / low stock /
  driver status / new returns / connection loss.
- **Bulk selection** with a contextual/sticky action bar and a destructive confirm (inline or
  dialog) that reports partial success.
- **Inline-create-and-auto-select** for products & suppliers (stacked above the current dialog),
  including barcode-prefill and variant creation.
- **Searchable pickers** (product by name+SKU), **unit combobox** (standardized but open), and
  **debounced address autocomplete** — with arrow/enter/escape keyboard nav on all of them.
- **Multi-channel invoice/order send** — WhatsApp (`wa.me`), SMS (`sms:`), and Email, shown
  conditionally on available contact info.
- **CSV export** (RFC-4180 quoting) and **auth-aware PDF download**.
- **Tenant branding** — runtime `--primary` CSS-var injection driving the accent/logo, non-fatal if
  absent; keep the `brand` (static) vs `primary` (tenant) distinction.
- **PWA install** prompts (Android banner / iOS tip / explicit install modal).
- **All money is `$X.XX`**, `total = subtotal + tax` (±$0.01), ≤ 2 decimals everywhere, never
  re-derive boxed lines, override = net price + struck-through original + `discount: 0`.

---

## 💡 Faster ways (cross-cutting suggestions — NOT baked in)

> Improvement ideas quarantined here per the inventory convention. The redesign team decides.

- **Standardize empty states & skeletons everywhere.** `EmptyState` and skeleton rows exist but are
  applied unevenly (catalogue #7). Make a redesigned list template that _always_ includes both, so
  no page ships with a bare "No data" string.
- **Unify the two bulk bars.** The orders inline bulk bar and `StockCountBulkBar` are separate
  implementations of the same idea. One shared `BulkActionBar` (sticky, count + actions + confirm)
  would cut duplication and inconsistency.
- **Unify the table story.** Three coexisting approaches (`Table` component, `SortableTh` + raw
  markup, plain tables). Pick one data-table primitive with built-in sort/skeleton/empty/row-click
  so every list looks and behaves identically.
- **Add undo to destructive actions.** Bulk cancel/delete and single deletes are irreversible + a
  confirm. A toast with an **Undo** action (soft-delete + delayed commit) is faster _and_ safer than
  a confirm dialog and would fit the existing toast system.
- **Make shortcuts discoverable.** g-sequences and ⌘K are invisible until you press `?`. Surface a
  subtle "Press ? for shortcuts" hint, show ⌘K in the top-bar search affordance, and add
  `title`/kbd hints on nav items.
- **Add a UTF-8 BOM to CSV exports.** `downloadCsv`/`exportReportCSV` omit the BOM; Excel then
  mis-detects encoding on accented data. Prepend `﻿` in one place.
- **Consolidate CSV exporters.** `export.ts` and `report-export.ts` are near-duplicates with
  different line endings — merge into one utility (and fix the BOM there).
- **Drag-and-drop where it's manual reordering today.** Route stop ordering, invoice line reordering,
  and saved-view arrangement are prime candidates for drag handles.
- **Persist saved views + let users define their own.** Today `SAVED_VIEWS` is a hardcoded array on
  Orders only. A user-editable, per-list saved-view store (name + filter snapshot) generalizes the
  pattern to invoices, customers, products.
- **Collapse the token systems.** Merge the preset/app brand-scale split, dedupe the type scale, and
  fold the four palettes into one themed system with `brand` (static) and `primary` (tenant) as the
  only accent axes — then decide whether to ship the already-drafted dark mode.
