# Area: web (`apps/web`)

Next.js 14 App Router operator/buyer dashboard with multi-tenant Radix + Tailwind UI; the
**golden reference** for API flows and DTOs; dev on `:3001`.

## Where to find (this area)

| Need                  | File → symbol                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & tenant context | `middleware.ts` — tenant slug, mobile redirect, buyer-vs-operator guard, signed-in landing 307 (`/` → /dashboard or /buyer/portal)                                  |
| Presence cookies      | `lib/presence-cookies.ts` — `rf-op-auth`/`rf-buyer-auth`, 3-day TTL = refresh-token TTL; re-set on refresh, cleared on dead session (feeds the middleware redirect) |
| Operator auth model   | `lib/auth.ts` — `migrateLegacyOpToken()`, `AuthUser`, refresh-on-401                                                                                                |
| Auth hook             | `lib/auth-context.tsx` — `useAuth()`, sign-in/out, user/role state                                                                                                  |
| Token namespaces      | `lib/auth-keys.ts` — `OP_KEYS`, `BUYER_KEYS`, `DRIVER_KEYS` (localStorage)                                                                                          |
| Tenant slug cookie    | `lib/tenant-cookie.ts` — `setTenantCookie()`, `clearTenantCookie()` (non-httpOnly)                                                                                  |
| HTTP client & headers | `lib/api-client.ts` — axios, base URL, Bearer + X-Tenant-Slug, 401 refresh queue                                                                                    |
| Buyer HTTP client     | `lib/buyer-api-client.ts` — isolated, reads BUYER_KEYS only                                                                                                         |
| Super-admin client    | `lib/admin-api.ts` — `superAdminClient`, impersonation                                                                                                              |
| Operator login        | `app/(auth)/login/page.tsx` — workspace picker, legacy token migration                                                                                              |
| OAuth callback        | `app/(auth)/platform/auth/callback/page.tsx`                                                                                                                        |
| Buyer login & portal  | `app/buyer/login/page.tsx`, `app/buyer/layout.tsx`                                                                                                                  |
| Buyer auth hook       | `lib/buyer-auth-context.tsx` — `useBuyerAuth()`, active seller, multi-seller switch                                                                                 |
| Tenant branding       | `components/tenant-provider.tsx` — fetch branding, inject CSS vars                                                                                                  |
| Security & headers    | `next.config.mjs` — CSP, X-Frame-Options DENY, hardening                                                                                                            |
| Socket.io realtime    | `lib/socket.ts` — `connectSocket()`, `getSocket()`, reconnect                                                                                                       |

## App shell & lib

- **Unified "Ledger" design foundation (Phase 1).** `app/globals.css` holds the full Ledger CSS-var
  set (ink/paper/canvas/sunken/line, brand teal, per-surface `--accent`, status, radii, shadows,
  fonts, `--text-body 13.5px` density) mirroring `docs/design-package/project/unified/rf.css`; adds
  `.surface-buyer` (emerald) / `.surface-admin` (indigo) overrides + `.money`/`.mono`/`.overline`/
  `.skeleton` utilities. Tailwind semantic tokens (preset) resolve against these vars, so the whole
  app adopts the palette without per-screen edits. `app/(dashboard)/layout.tsx` operator rail/topbar
  restyled to the Ledger (ink-900 rail, active `white/10` + inset teal-300 bar, ⌘K search pill;
  **Bills & Purchasing** added under Warehouse → `/vendor-bills`). Buyer portal + platform-admin
  layouts carry the `.surface-buyer`/`.surface-admin` class. Plan + tracker:
  `docs/design-package/IMPLEMENTATION-PLAN.md`; open questions: `/QUESTIONS.md`.
- **Phase 1d behavioral UX standards.** `lib/undo.ts` — `useUndo()` (reversible act + 8s Undo toast;
  Toast now returns an id + `dismiss()` and has an `action` slot). `lib/session-expiry.ts` +
  `components/ReAuthProvider.tsx` — in-place re-auth sheet; `lib/api-client.ts` 401 handler pauses the
  failed request and calls `requestReauth()` before falling back to the /login redirect. `lib/i18n/`
  (`messages.ts` en/es catalog, `index.tsx` `I18nProvider`/`useI18n()`/`t()`) — per-user locale via
  `UserPreference` + localStorage; avatar-menu Language toggle. `CommandPalette.tsx` — Jump-to/Actions/
  Results sections, `? shortcuts`, localized. All mounted in `app/providers.tsx`
  (`ToastProvider > I18nProvider > ReAuthProvider > QueryProviders`). Customer delete
  (`customers/[id]/page.tsx`) is now a reversible soft-delete with Undo (`useSoftDeleteCustomer`/
  `useRestoreCustomer`).
- **`app/layout.tsx`** — root metadata, fonts (Spline Sans + Spline Sans Mono + Instrument Serif +
  Inter fallback), `<Providers>` + `<TenantProvider>` + SW registry.
- **`app/providers.tsx`** — QueryClient/TanStack Query, Zustand, toast container.
- **`next.config.mjs`** — standalone output (Docker), CSP headers, X-Frame-Options DENY, image domains. **`Permissions-Policy: camera=(self), geolocation=(self)`** — `camera=()` previously disabled the in-browser barcode/invoice scanner on Android Chrome ("access denied"; iOS Safari ignored it).
- **`lib/api-client.ts`** — axios instance, `getTenantSlugFromCookie()`, token+tenant interceptors, refresh queue.
- **`lib/auth.ts`** — operator auth types + `migrateLegacyOpToken()`.
- **`lib/tenant-cookie.ts`** — shared cookie util (non-httpOnly — JS-readable required).
- **`lib/socket.ts`** — Socket.io singleton, token auth, reconnect.
- **`lib/auth-keys.ts`** — `OP_KEYS`/`BUYER_KEYS`/`DRIVER_KEYS` (prevent cross-context token bleed).
- **`lib/page-title-context.tsx`** — `usePageTitle()`.
- **`lib/pricing.ts`** — `getTierPrice`, `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`,
  the margin helpers `costPerSellingUnit`/`computeMarginFraction`/`priceForMarginFloor`/`classifyMargin`
  (box-vs-piece aware; the sale-builder "negotiation floor"), and **`applyBestPromotion`/`promotionMatchesProduct`**
  (P5-04). Mirror of `apps/api/src/common/pricing.ts` (+ `apps/mobile/lib/pricing.ts`) — keep all three in sync.
- **Promotions pricing (P5-04):** `lib/api/buyer.ts` `useBuyerPromotions()` + `BuyerPromotion`; the buyer cart
  `buyer/portal/[seller]/cart/page.tsx` evaluates each line's best promo via the SAME `applyBestPromotion`
  (base = the catalog `buyerPrice`) → per-line strikethrough + a "Promotion savings" summary line (net line
  subtotals reconcile to the total). Operator order-detail, buyer order-detail, and invoice-detail render the
  `PriceType.PROMO` strikethrough/badge (web `PriceType` unions in `lib/api/{orders,invoices}.ts` += `PROMO`).
- **`lib/api/margin.ts`** — `useMarginConfig()`/`useUpdateMarginConfig()` (tenant costing method +
  margin floors via `/settings/margin`) + `floorForCategory()`. Shared **`components/MarginHint.tsx`**
  (cost·margin under a line, red below floor, Set-to-floor / Sell-anyway) is used by both the order-detail
  edit path AND `CreateOrderModal` (inline dup removed); with a `productId` the cost text opens a
  **cost-history popover** (portaled to `<body>` to clear the modal's transform+overflow) via
  **`lib/api/cost-history.ts`** `useCostHistory(productId)` (also backs products/[id] `CostHistoryCard`;
  `GET /analytics/cost-history/:id`). Analytics **Gross Margin** card states the configured costing method.
- **Minimize & resume drafts (Phase 2 §2, pos-cost-roles-spec).** `lib/api/drafts.ts` — `useDrafts`/
  `useDraft(id)`/`useCreateDraft`/`useUpdateDraft`/`useDeleteDraft` over `/drafts` (per-user,
  tenant-scoped; OPERATOR/DRIVER, TENANT_ADMIN satisfies OPERATOR). `lib/drafts.ts` — `OrderDraftPayload`
  (full builder state), `draftDeviceLabel()`, `parkedAgo()`, `draftSummary()`. `components/DraftDock.tsx`
  — persistent dock at the bottom-left of the content column (mounted in `(dashboard)/layout.tsx`
  right-column, non-CUSTOMER roles), lists parked drafts + Resume/Discard + a global scan-to-draft
  wedge-listener (active only while a draft is parked; bails inside any open `[role=dialog]`).
  `CreateOrderModal.tsx` gained a **Minimize** footer button + `resumeDraftId`/`initialScanCode` props:
  parks/hydrates/autosaves (debounced, bound to a draft only after Minimize/Resume) + auto-adds a
  scanned barcode on open + deletes the draft on successful submit. `orders/page.tsx` reads
  `?resumeDraft`/`?scan`/`?action=new` reactively to open the builder. Backend: `api/src/drafts/`.
- **`lib/product-display.ts`** — `displayProductName(product, allProducts?)` composes `"<Parent> - <Variant>"` for variant rows (parent relation → allProducts lookup → bare variant name) + exported `PRODUCT_NAME_SEPARATOR = " - "` (the ONE separator; no hand-composed `·` anywhere). Hand-synced mirror: `apps/mobile/lib/product-display.ts`. **`lib/image-focal.ts`** — product focal-point crop (4:5), image fit.
- **`lib/barcode-resolve.ts`** — `BarcodeResolveHit<T>`/`Miss` types.
- **`lib/formatting.ts`**, **`lib/export.ts`** (`downloadCsv()`), **`lib/report-export.ts`** — format + CSV/report export.
- **`lib/use-sortable-data.ts`** — table sort/pagination hook.
- **`lib/stock-count-storage.ts`**, **`lib/buyer-cart.ts`**, **`lib/fetch-pdf-blob.ts`** — local state + PDF blobs.
- **`lib/admin-api.ts`**, **`lib/buyer-auth.ts`**, **`lib/buyer-api-client.ts`** — admin & buyer clients/types.
- **`lib/hooks/`** — `useNotifications`, `useBuyerNotifications`, `useRealtimeUpdates` (socket→query invalidation), `useUrlFilters` (filter↔URL), `useDebounce`.
- **`lib/drive-mode.tsx`** — Drive mode (pos-cost-roles-spec §4, "role = permissions; mode = layout").
  `useDriveMode()` → `{ driveMode, setDriveMode(on), toggle() }`, localStorage key `rf-drive-mode`
  (SSR-safe: `false` on server/first render, hydrated in an effect; cross-tab via `storage` event +
  an in-module listener set so same-tab toggles also re-sync). No deps, no API call. Consumed by
  `(dashboard)/layout.tsx` Header (topbar chip + one-tap Exit, avatar-menu toggle) and
  `routes/my-runs/page.tsx` (field-layout switch).

## Routes (`app/`)

### `(auth)/` — operator login & OAuth

- `login/page.tsx` — workspace picker, email/password, legacy token migration.
- `signup/page.tsx`, `signup/check-email/page.tsx` — signup + confirmation.
- `admin-login/page.tsx` — super-admin login (uses `superAdminClient`).
- `platform/auth/callback/page.tsx` — Google OAuth callback.

### `(dashboard)/` — operator dashboard (middleware-guarded)

- `dashboard/page.tsx` — KPI cards (pending orders, routes, drivers, receivables), tables.
- `settings/page.tsx` — branding, invoice numbering, delivery defaults. `settings/import/page.tsx` — bulk import.
- **Order create / scan-to-add:** `orders/_components/CreateOrderModal.tsx` and `invoices/new/page.tsx` both **auto-scroll the just-scanned line into view** (ref-map + `scrollIntoView`); CreateOrderModal pre-fills remembered price (`useCustomerPriceHistory`).
- **Orders/fulfillment:** `orders/page.tsx` (status views, bulk delete, export), `orders/[id]/page.tsx` (items, pricing tiers, timeline, return, send to route; **inline per-line unit-price edit + "$ off/unit" discount on DRAFT/PENDING/CONFIRMED** (gated by `canEditPrice={canEdit}`; was DRAFT-only) via `PriceEditRow` → net `unitPrice`/`overrideReason` to `PATCH /orders/:id/items`; reads `MANUAL` priceType strikethrough; `EditableLineItems` pre-fills remembered price from `useCustomerPriceHistory` + auto-scrolls the scanned row into view; `handleSaveItems` sends an incremental diff with **`replaceAll: false`** so adding an item never deletes the untouched lines); `routes/page.tsx`, `routes/create/page.tsx` (pick stops → optimize → assign), `routes/[id]/page.tsx` (live-run stop list w/ live status + map; `StopItem` takes an
  `onAtDoorActions` prop and shows an "At-door actions" button on the `IN_PROGRESS` (current) stop →
  opens the shared `ArrivedStopSheet` — Phase 2 §3, the real driver at-door surface), `routes/[id]/dispatch/page.tsx` (pre-run
  packing-list/loading-manifest view; `RequiredStopCard` shows an "At-door actions" button when a
  stop's packing status is `IN_PROGRESS` (arrived) → opens `ArrivedStopSheet` for that stop, Phase 2
  §3), `routes/templates/[id]/page.tsx`, `routes/my-runs/page.tsx` (driver's own runs; reskins to the **Drive mode** field layout — today's run promoted to a hero card with big stop rows, Progress/Next Stop/Delivered-Today `StatCard`s, and a prominent "Scan to add order" primary action linking `/orders?action=new&scan=1` — when `useDriveMode().driveMode` is true; same `useRouteRuns`/data untouched, off-state renders the prior compact Today/Upcoming lists).
- **Invoicing/payments:** `invoices/page.tsx`, `invoices/new/page.tsx`, `invoices/[id]/page.tsx` (mark paid, apply credit/advance, void, email, PDF), `invoices/[id]/edit/page.tsx`, `invoices/recurring/page.tsx`, `invoices/recurring/new/page.tsx`.
- **Finance:** `finance/dashboard/page.tsx` (AR aging, sales breakdowns), `finance/expenses/page.tsx` + `new/page.tsx` (OCR), `finance/payments/page.tsx` + `[id]/page.tsx`, `finance/reports/page.tsx` (AR aging, P&L, cash flow, expense breakdown).
  - `finance/expenses/page.tsx` is the **"Bills & Purchasing"** hub — 3 tabs: **Vendor Bills** (`InventoryPurchasesTab`, `useVendorBills`), **Purchase Orders** (`PurchaseOrdersTab`, read-only Ledger table off `usePurchaseOrders()` from `lib/api/inventory.ts`; PO status → `poBadge()` since the PO enum isn't in the shared Badge map), **Other Expenses** (`OtherExpensesTab`, `useExpenses`). KPI grid uses `StatTile` (Open Bills / Due This Week / Unlinked Items filter-toggle / Spend-30d — all derived client-side from the loaded bill list, no new endpoints). No web PO create/detail route exists (`/purchases` just redirects here), so no "New PO" button and PO rows aren't clickable.
- **Credit notes/estimates:** `credit-notes/page.tsx` + `[id]/page.tsx`; `estimates/page.tsx` + `[id]/page.tsx` (convert to invoice).
- **People:** `customers/page.tsx`, `customers/create/page.tsx`, `customers/[id]/page.tsx` (form `_components/CustomerFormModal.tsx` — **email is OPTIONAL**; username derived from name when email absent; `SpecialPricesTab` tier cells/option-labels/preview append a subdued "(list)" suffix via local `tierUnset()` when the chosen tier column is 0/unset — price itself already falls back via `getTierPrice`); `drivers/page.tsx`, `drivers/[id]/page.tsx`.
- **Merchandising / promotions (P5-01):** `promotions/page.tsx` — operator manager for tenant promotions (list + status-chip filter (Active/Scheduled/Paused/Expired via `promotionStatus()`), create/edit `Modal` with typed rule (PERCENT/FIXED/QTY_BREAK), scope (ALL/CATEGORY/PRODUCTS) incl. an inline searchable multi-product picker, `datetime-local` window, pause/resume, delete). Nav leaf "Promotions" (Megaphone) under Warehouse in `(dashboard)/layout.tsx` + a CommandPalette `nav-promotions` entry. Consumes `lib/api/promotions.ts` only — **no pricing applied here** (cart-time application is P5-04). `products/[id]/page.tsx` gained a "Buyer merchandising" toggle card (Featured/New/Deal → `useUpdateProduct` isFeatured/isNew/isDeal) + header badges; `products/page.tsx` grid card + table cell show the same badges via a local `MerchBadges`.
- **Inventory/sourcing:** `products/page.tsx`, `products/[id]/page.tsx` (pricing tiers — READ mode renders unset (0) tiers as the inherited list price + tiny "list" badge, edit mode has a persistent "Tiers left at 0 inherit the list price" helper, variants-table Tier 2 cells use `getTierPrice(…, 2)`; image+focal editor, variants, `CostHistoryCard` from /analytics/cost-history, amber "No cost set" states); `inventory/page.tsx` (valuation card + missing-cost chip/filter, `SetCostModal`/`BulkSetCostModal`/`RecomputeModal` dry-run→apply); `inventory/movements/page.tsx`; `suppliers/page.tsx` + `[id]/page.tsx`; `vendor-bills/page.tsx` + `[id]/page.tsx` (`UnlinkedItemsModal` catches UNLINKED_ITEMS 409, unmapped-DRAFT banner); vendor-bill LIST lives in `finance/expenses/page.tsx` `InventoryPurchasesTab` (needs-mapping KPI chip + row badge).
- **Returns/analytics:** `returns/page.tsx` (list — reskinned to Unified Ledger per `docs/design-package/project/unified/returns.html`: `PageHeader`+subtitle, 3 KPI stat cards incl. warning-ring "Awaiting Review", status-chip filter bar (all `ReturnStatus` values, not just the design's 5) + reason `<select>` + search, table gained a computed "Value" column (sum of `item.unitPrice*qty`, presentational only), row action button "Review"/"View" by status — same `useReturns`/`useCreateReturn`, same handlers/filters/pagination, unchanged) + `[id]/page.tsx` (detail — NOT reskinned yet; approve/reject/in-transit/received/refund live here); `analytics/page.tsx`.
- **Tobacco (addon-gated):** `tobacco/page.tsx` — KPIs, monthly chart, tabs (Reports w/ CSV+PDF downloads + generate/regenerate, Inventory, Purchases w/ supplier license, Sales w/ customer-license warnings), TENANT_ADMIN exclusion-toggle card; nav "Tobacco" leaf spliced after Analytics in `layout.tsx` when `useHasAddon("tobacco_dealer")`; product detail Mark-as-tobacco action + banner; product list tobacco badge. Hooks: `lib/api/tobacco.ts` (`useTenantAddons`/`useHasAddon` = the flag read, staleTime 5 min).
- **Regulated Items / compliance (Phase 4 B1):** `compliance/page.tsx` — **"Regulated Items"** hub: KPI cards (Tracked Categories / Regulated Products / Tax-this-month / Filings) + a per-category rules grid (tax rule, invoice treatment, license/active badges) off `useTrackedCategories()` (`lib/api/tracked-categories.ts`, W2 hooks). Tax/Filing KPIs bind to the existing tobacco overview when the addon is present (generic ledger + filings arrive W5). Nav: `layout.tsx` injects **Regulated Items** (`/compliance`, `ShieldCheck`) + keeps **Tobacco** after `/analytics`, gated on the tobacco addon. `products/[id]/page.tsx` gained a **"Separately handled: {category}"** field when the product has a `trackedCategory` (API `findOne` now includes `trackedCategory {id,name}`). Paired-invoice chip deferred to W4 (no `invoiceGroupId` data until then).
- **Regulated license web surfaces (Phase 4 W6b):** operator **customer-detail Licenses tab** (`customers/_components/AuthorizationsTab.tsx`, wired into `customers/[id]/page.tsx` as `<TabTrigger value="authorizations">`) — list rows w/ status badge (local `authStatusBadge`, since Badge lacks VERIFIED/PENDING_REVIEW/NONE), approve/reject/renew + add wholesaler-added license (category picker off `useTrackedCategories`). **Order-builder license guard** `orders/_components/LicenseGuardModal.tsx` — catches 409 `REGULATED_AUTH_REQUIRED` (parsed by `parseRegulatedAuthError` in `lib/api/authorizations.ts`), **3 exits: capture license / §8 override / remove line**; wired into `CreateOrderModal` (`LineItem.trackedCategoryId` added + set from `product.trackedCategoryId`; retry via `licenseRetryRef`; UNTIL-24h override scope pre-create) and `orders/[id]/page.tsx` (`guardError` on updateItems/updateStatus/publish; ORDER override scope; remove-exit omitted — lines removed via edit UI). **Buyer self-serve** `buyer/portal/[seller]/licenses/page.tsx` (+ `ShieldCheck` nav in `buyer/portal/layout.tsx`) — per-category status + submit/renew w/ consent. **`providers.tsx`** MutationCache now skips the generic error toast for handled 409 codes (`MERGE_CHOICE_REQUIRED`, `REGULATED_AUTH_REQUIRED`). Hooks: `lib/api/authorizations.ts` (operator: `useCustomerAuthorizations`/`useCreate|Approve|Reject|RenewAuthorization`/`useCreateAuthorizationOverride` + `parseRegulatedAuthError`/`displayAuthStatus`/`authStatusBadge`), `lib/api/buyer.ts` (`useBuyerAuthorizations`/`useSubmitBuyerAuthorization`).
- **B2 category manager (Phase 4 B2, frontend-only on the W2 API):** `compliance/page.tsx` gained **New category** button + per-card **Products / Edit / Deactivate** actions. `components/CategoryFormModal.tsx` (create/edit — name, taxType, rate [percent stored as fraction], unitBasis, invoiceTreatment, reportTemplate/cadence, priceIncludesTax, requiresLicense) via `useCreate/UpdateTrackedCategory`. `components/AssignProductsModal.tsx` — bulk assign/unassign products to a category (searchable list off `useProducts({limit:0})`, one-max moves signalled, diffs against `product.trackedCategoryId`) via `useAssign/UnassignProductsToCategory`. Toggle via `useToggleTrackedCategory`. Product-FORM picker + scope selector still deferred.
- **Other:** `dispatch/page.tsx`, `bookkeeping/page.tsx` + `[transactionId]/page.tsx`.

### `(platform-admin)/` — super-admin panel (role-guarded)

- `admin/dashboard/page.tsx` — platform stats (tenants, users, plans, MRR).
- `admin/tenants/page.tsx`, `new/page.tsx`, `[id]/page.tsx` (edit plan, trial, suspend, impersonate, audit).
- `admin/buyers/page.tsx` + `[id]/page.tsx`; `admin/buyers/merge-requests/page.tsx` + `[id]/page.tsx`.
- `admin/plans/page.tsx`, `admin/billing/page.tsx`, `admin/audit-logs/page.tsx`, `admin/{profile,settings}/page.tsx`.

### `buyer/` — buyer portal (multi-seller B2B)

- **Auth:** `login/page.tsx`, `register/page.tsx`, `change-password/page.tsx`, `invite/[token]/page.tsx`, `verify-merge/page.tsx`.
- **Portal (`portal/[seller]/`):** `page.tsx` (landing), `shop/page.tsx` (browse/cart), `cart/page.tsx` (checkout → order), `dashboard/page.tsx`, `orders/page.tsx` + `[id]/page.tsx`, `invoices/page.tsx` + `[id]/page.tsx` (PDF), `templates/page.tsx`, `favorites/page.tsx`, `finances/page.tsx`, `licenses/page.tsx` (W6b — self-serve license submit/renew), `account/page.tsx`; `portal/settings/page.tsx`.

### `(marketing)/` — public site

- `page.tsx` (home), `product/`, `company/`, `retailers/`, `wholesalers/`, `distributors/`, `pricing/`.

### Top-level

- `change-password/page.tsx`, `contact/page.tsx`.

## E2E tests (`apps/web/e2e/`)

Playwright against production (`routeflowweb-production.up.railway.app`). Auth via per-role
storage-state JSON (created once by `setup/auth.setup.ts`). **No mutations — read-only so safe
against production data.**

| File                            | Project          | Coverage                                                 |
| ------------------------------- | ---------------- | -------------------------------------------------------- |
| `01-super-admin.spec.ts`        | `super-admin`    | SA-01–12 admin panel                                     |
| `02-operator.spec.ts`           | `operator`       | OP-01–22 dashboard, orders, invoices, routes, finance    |
| `03-customer.spec.ts`           | `customer`       | CU-\* customer portal                                    |
| `04-buyer-portal.spec.ts`       | `buyer`          | BP-\* buyer B2B portal                                   |
| `05-cross-cutting.spec.ts`      | `cross-cutting`  | CC-\* auth edge cases                                    |
| **`06-critical-paths.spec.ts`** | `critical-paths` | **CP-01–10 money-math regression + float-artifact scan** |

`06-critical-paths.spec.ts` is the key regression guard for the money-math fix: verifies all
displayed amounts are `$X.XX`, API money fields have ≤2 dp, and invoice `total = subtotal + tax`.

Run: `cd apps/web && npx playwright test` (all projects) or `--project=critical-paths`.

## Components & shared

- `tenant-provider.tsx` (branding CSS vars), `CommandPalette.tsx` (Cmd+K nav/search),
  `BarcodeScannerButton.tsx`, `DocumentLetterhead.tsx` (PDF header), `ScanInvoiceModal.tsx` (OCR),
  `SearchableProductPicker.tsx`, `SupplierSelect.tsx`, `InlineCreate{Product,Supplier}Modal.tsx`
  (Product modal's `CreatedProduct` carries `unitsPerBox`/`parentProductId`/`variantName`/`parent`
  so `onCreated` consumers — CreateOrderModal, invoices/new — get the Boxes+Pcs editor + the
  `displayProductName` label for a just-created boxed product/variant),
  `AddressAutocomplete.tsx` (Google Maps), `UnitCombobox.tsx`, `GroupAsVariantsModal.tsx`,
  `ConfirmDialog.tsx`, `DraftDock.tsx` (parked-draft dock + scan-to-draft, Phase 2 §2),
  `ArrivedStopSheet.tsx` (Phase 2 §3 at-door actions sheet: `Modal` w/ 3 nav tiles — Adjust order
  → `/orders/{orderId}` (shown only if the stop has an order), New order at door →
  `/orders?action=new`, Collect payment → `/finance/payments`; pure navigation dispatcher, no new
  API/state, closes on selection via `router.push`),
  `SortableTh.tsx`, `ReportChart.tsx` (recharts), `ReportToolbar.tsx`,
  `TenantLogo.tsx`, `PwaInstallPrompt.tsx`/`InstallAppButton.tsx`, `ServiceWorkerRegistry.tsx`,
  `AutoRedirectIfAuthed.tsx`, `inventory/StockCount{Tab,Row,BulkBar,ReviewModal}.tsx`.

## API hooks (`lib/api/`)

Each module exports TanStack Query hooks + TS types mirroring API DTOs. Key entries:

| Module               | Key hooks                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders.ts`          | `useOrders`, `useOrder`, `useCreateOrder`, `useUpdateOrderStatus`, `useToggleUrgent`, `useReopenOrder`, `useBulkDeleteOrders`                                                                                                              |
| `invoices.ts`        | `useInvoices`, `useInvoice`, `useCreateInvoice`, `useUpdateInvoice`, `useSendInvoice`, `useVoidInvoice`, `useApplyCreditNote`, `useApplyAdvanceToInvoice`, `useDownloadInvoicePdf`, `useRecordInvoicePayment`, `useRecurringInvoices`      |
| `routes.ts`          | `useRoutes`, `useRoute`, `useCreateRoute`, `useAddStopToRoute`, `useUpdateRoute`, `useRouteRuns`, `useCreateRouteRun`, `useOptimizeRoute`, `useAnalyzeRoute`                                                                               |
| `customers.ts`       | `useCustomers`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`, `useDeleteCustomer` (hard), `useSoftDeleteCustomer` (force → restorable) + `useRestoreCustomer` (8s-undo pair)                                                    |
| `products.ts`        | `useProducts`, `useProduct`, `useProductByBarcode`, `useCreateProduct`, `useUpdateProduct`, `useBulkAssignParent` (one POST `/products/bulk-assign-parent` → `BulkAssignParentResult{succeeded,failed}`; consumed by GroupAsVariantsModal) |
| `drivers.ts`         | `useDrivers`, `useDriver`, `useCreateDriver`, `useUpdateDriver`, `useChangeDriverStatus`, `useDriverHistory`, `useDriverMetrics`                                                                                                           |
| `suppliers.ts`       | `useSuppliers`, `useSupplier`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`                                                                                                                                           |
| `returns.ts`         | `useReturns`, `useReturn`, `useCreateReturn`, `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`, `useMarkReturnReceived`, `useProcessRefund`                                                                                 |
| `estimates.ts`       | `useEstimates`, `useEstimate`, `useCreateEstimate`, `useUpdateEstimate`, `useSendEstimate`, `useConvertEstimate`                                                                                                                           |
| `credit-notes.ts`    | `useCreditNotes`, `useCreditNote`, `useCreateCreditNote`, `useIssueCreditNote`, `useApplyCreditNote`, `useVoidCreditNote`                                                                                                                  |
| `vendor-bills.ts`    | `useVendorBills` (+`needsMapping`, meta.needsMappingCount), `useVendorBill`, `useCreateVendorBill`, `useReceiveVendorBill` (`{id, acknowledgeUnlinked?}`), `getUnlinkedItemsError`                                                         |
| `finance.ts`         | `useFinanceDashboard`, `useArAgingInvoices`, `useSalesByCustomer`, `useSalesByItem`, `useProfitAndLoss`, `useCashFlow`, `useExpenses`, `useCreateExpense`, `useUploadExpenseReceipt`                                                       |
| `bookkeeping.ts`     | `useTransactions`, `useTransaction`, `usePayments`, `usePayment`                                                                                                                                                                           |
| `inventory.ts`       | `useStockOverview`, `useStockMovements`, `useRecordPurchase`, `useRecordAdjustment`, `usePurchaseOrders`, `useForecasting`, `useInventoryValuation`, `useSetCostBasis`, `useBulkSetCostBasis`, `useRecomputeCosts`                         |
| `order-templates.ts` | `useOrderTemplates`, `useOrderTemplate`, `useCreateOrderTemplate`, `useGenerateTemplateOrder`                                                                                                                                              |
| `buyer.ts`           | `useBuyerProducts`, `useBuyerOrder`, `useBuyerCreateOrder`, `useBuyerCancelOrder`, `useBuyerInvoice`, `useBuyerDashboard`, `useBuyerFavorites`, `useBuyerAnalytics`, `useBuyerAuthorizations`, `useSubmitBuyerAuthorization` (W6b)         |
| `promotions.ts`      | (P5-01) `usePromotions`, `usePromotion`, `useCreatePromotion`, `useUpdatePromotion`, `useSetPromotionActive`, `useDeletePromotion`; helpers `promotionStatus`/`promotionRuleLabel` + `Promotion`/`PromotionInput` types                    |
| `authorizations.ts`  | (W6b, operator) `useCustomerAuthorizations`, `useCreate/Approve/Reject/RenewAuthorization`, `useCreateAuthorizationOverride`; helpers `parseRegulatedAuthError`/`displayAuthStatus`/`authStatusBadge`                                      |
| `users.ts`           | `useMe`, `useChangePassword`, `useUpdateProfile`                                                                                                                                                                                           |
| `notifications.ts`   | `useNotificationCount`, `useUnreadNotifications`                                                                                                                                                                                           |
