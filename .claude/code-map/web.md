# Area: web (`apps/web`)

Next.js 14 App Router operator/buyer dashboard with multi-tenant Radix + Tailwind UI; the
**golden reference** for API flows and DTOs; dev on `:3001`.

## Where to find (this area)

| Need                  | File → symbol                                                                       |
| --------------------- | ----------------------------------------------------------------------------------- |
| Auth & tenant context | `middleware.ts` — tenant slug, mobile redirect, buyer-vs-operator guard             |
| Operator auth model   | `lib/auth.ts` — `migrateLegacyOpToken()`, `AuthUser`, refresh-on-401                |
| Auth hook             | `lib/auth-context.tsx` — `useAuth()`, sign-in/out, user/role state                  |
| Token namespaces      | `lib/auth-keys.ts` — `OP_KEYS`, `BUYER_KEYS`, `DRIVER_KEYS` (localStorage)          |
| Tenant slug cookie    | `lib/tenant-cookie.ts` — `setTenantCookie()`, `clearTenantCookie()` (non-httpOnly)  |
| HTTP client & headers | `lib/api-client.ts` — axios, base URL, Bearer + X-Tenant-Slug, 401 refresh queue    |
| Buyer HTTP client     | `lib/buyer-api-client.ts` — isolated, reads BUYER_KEYS only                         |
| Super-admin client    | `lib/admin-api.ts` — `superAdminClient`, impersonation                              |
| Operator login        | `app/(auth)/login/page.tsx` — workspace picker, legacy token migration              |
| OAuth callback        | `app/(auth)/platform/auth/callback/page.tsx`                                        |
| Buyer login & portal  | `app/buyer/login/page.tsx`, `app/buyer/layout.tsx`                                  |
| Buyer auth hook       | `lib/buyer-auth-context.tsx` — `useBuyerAuth()`, active seller, multi-seller switch |
| Tenant branding       | `components/tenant-provider.tsx` — fetch branding, inject CSS vars                  |
| Security & headers    | `next.config.mjs` — CSP, X-Frame-Options DENY, hardening                            |
| Socket.io realtime    | `lib/socket.ts` — `connectSocket()`, `getSocket()`, reconnect                       |

## App shell & lib

- **`app/layout.tsx`** — root metadata, fonts, `<Providers>` + `<TenantProvider>` + SW registry.
- **`app/providers.tsx`** — QueryClient/TanStack Query, Zustand, toast container.
- **`next.config.mjs`** — standalone output (Docker), CSP headers, X-Frame-Options DENY, image domains. **`Permissions-Policy: camera=(self), geolocation=(self)`** — `camera=()` previously disabled the in-browser barcode/invoice scanner on Android Chrome ("access denied"; iOS Safari ignored it).
- **`lib/api-client.ts`** — axios instance, `getTenantSlugFromCookie()`, token+tenant interceptors, refresh queue.
- **`lib/auth.ts`** — operator auth types + `migrateLegacyOpToken()`.
- **`lib/tenant-cookie.ts`** — shared cookie util (non-httpOnly — JS-readable required).
- **`lib/socket.ts`** — Socket.io singleton, token auth, reconnect.
- **`lib/auth-keys.ts`** — `OP_KEYS`/`BUYER_KEYS`/`DRIVER_KEYS` (prevent cross-context token bleed).
- **`lib/page-title-context.tsx`** — `usePageTitle()`.
- **`lib/pricing.ts`** — `getTierPrice`, `computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney` (mirror of `apps/api/src/common/pricing.ts` — keep in sync).
- **`lib/product-display.ts`**, **`lib/image-focal.ts`** — product focal-point crop (4:5), image fit.
- **`lib/barcode-resolve.ts`** — `BarcodeResolveHit<T>`/`Miss` types.
- **`lib/formatting.ts`**, **`lib/export.ts`** (`downloadCsv()`), **`lib/report-export.ts`** — format + CSV/report export.
- **`lib/use-sortable-data.ts`** — table sort/pagination hook.
- **`lib/stock-count-storage.ts`**, **`lib/buyer-cart.ts`**, **`lib/fetch-pdf-blob.ts`** — local state + PDF blobs.
- **`lib/admin-api.ts`**, **`lib/buyer-auth.ts`**, **`lib/buyer-api-client.ts`** — admin & buyer clients/types.
- **`lib/hooks/`** — `useNotifications`, `useBuyerNotifications`, `useRealtimeUpdates` (socket→query invalidation), `useUrlFilters` (filter↔URL), `useDebounce`.

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
- **Orders/fulfillment:** `orders/page.tsx` (status views, bulk delete, export), `orders/[id]/page.tsx` (items, pricing tiers, timeline, return, send to route; **inline per-line unit-price edit + "$ off/unit" discount on DRAFT/PENDING/CONFIRMED** (gated by `canEditPrice={canEdit}`; was DRAFT-only) via `PriceEditRow` → net `unitPrice`/`overrideReason` to `PATCH /orders/:id/items`; reads `MANUAL` priceType strikethrough; `EditableLineItems` pre-fills remembered price from `useCustomerPriceHistory` + auto-scrolls the scanned row into view; `handleSaveItems` sends an incremental diff with **`replaceAll: false`** so adding an item never deletes the untouched lines); `routes/page.tsx`, `routes/create/page.tsx` (pick stops → optimize → assign), `routes/[id]/page.tsx`, `routes/[id]/dispatch/page.tsx` (live map + POD), `routes/templates/[id]/page.tsx`, `routes/my-runs/page.tsx`.
- **Invoicing/payments:** `invoices/page.tsx`, `invoices/new/page.tsx`, `invoices/[id]/page.tsx` (mark paid, apply credit/advance, void, email, PDF), `invoices/[id]/edit/page.tsx`, `invoices/recurring/page.tsx`, `invoices/recurring/new/page.tsx`.
- **Finance:** `finance/dashboard/page.tsx` (AR aging, sales breakdowns), `finance/expenses/page.tsx` + `new/page.tsx` (OCR), `finance/payments/page.tsx` + `[id]/page.tsx`, `finance/reports/page.tsx` (AR aging, P&L, cash flow, expense breakdown).
- **Credit notes/estimates:** `credit-notes/page.tsx` + `[id]/page.tsx`; `estimates/page.tsx` + `[id]/page.tsx` (convert to invoice).
- **People:** `customers/page.tsx`, `customers/create/page.tsx`, `customers/[id]/page.tsx` (form `_components/CustomerFormModal.tsx` — **email is OPTIONAL**; username derived from name when email absent); `drivers/page.tsx`, `drivers/[id]/page.tsx`.
- **Inventory/sourcing:** `products/page.tsx`, `products/[id]/page.tsx` (pricing tiers, image+focal editor, variants, `CostHistoryCard` from /analytics/cost-history, amber "No cost set" states); `inventory/page.tsx` (valuation card + missing-cost chip/filter, `SetCostModal`/`BulkSetCostModal`/`RecomputeModal` dry-run→apply); `inventory/movements/page.tsx`; `suppliers/page.tsx` + `[id]/page.tsx`; `vendor-bills/page.tsx` + `[id]/page.tsx` (`UnlinkedItemsModal` catches UNLINKED_ITEMS 409, unmapped-DRAFT banner); vendor-bill LIST lives in `finance/expenses/page.tsx` `InventoryPurchasesTab` (needs-mapping KPI chip + row badge).
- **Returns/analytics:** `returns/page.tsx` + `[id]/page.tsx` (approve/reject/in-transit/received/refund); `analytics/page.tsx`.
- **Other:** `dispatch/page.tsx`, `bookkeeping/page.tsx` + `[transactionId]/page.tsx`.

### `(platform-admin)/` — super-admin panel (role-guarded)

- `admin/dashboard/page.tsx` — platform stats (tenants, users, plans, MRR).
- `admin/tenants/page.tsx`, `new/page.tsx`, `[id]/page.tsx` (edit plan, trial, suspend, impersonate, audit).
- `admin/buyers/page.tsx` + `[id]/page.tsx`; `admin/buyers/merge-requests/page.tsx` + `[id]/page.tsx`.
- `admin/plans/page.tsx`, `admin/billing/page.tsx`, `admin/audit-logs/page.tsx`, `admin/{profile,settings}/page.tsx`.

### `buyer/` — buyer portal (multi-seller B2B)

- **Auth:** `login/page.tsx`, `register/page.tsx`, `change-password/page.tsx`, `invite/[token]/page.tsx`, `verify-merge/page.tsx`.
- **Portal (`portal/[seller]/`):** `page.tsx` (landing), `shop/page.tsx` (browse/cart), `cart/page.tsx` (checkout → order), `dashboard/page.tsx`, `orders/page.tsx` + `[id]/page.tsx`, `invoices/page.tsx` + `[id]/page.tsx` (PDF), `templates/page.tsx`, `favorites/page.tsx`, `finances/page.tsx`, `account/page.tsx`; `portal/settings/page.tsx`.

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
  `SearchableProductPicker.tsx`, `SupplierSelect.tsx`, `InlineCreate{Product,Supplier}Modal.tsx`,
  `AddressAutocomplete.tsx` (Google Maps), `UnitCombobox.tsx`, `GroupAsVariantsModal.tsx`,
  `ConfirmDialog.tsx`, `SortableTh.tsx`, `ReportChart.tsx` (recharts), `ReportToolbar.tsx`,
  `TenantLogo.tsx`, `PwaInstallPrompt.tsx`/`InstallAppButton.tsx`, `ServiceWorkerRegistry.tsx`,
  `AutoRedirectIfAuthed.tsx`, `inventory/StockCount{Tab,Row,BulkBar,ReviewModal}.tsx`.

## API hooks (`lib/api/`)

Each module exports TanStack Query hooks + TS types mirroring API DTOs. Key entries:

| Module               | Key hooks                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.ts`          | `useOrders`, `useOrder`, `useCreateOrder`, `useUpdateOrderStatus`, `useToggleUrgent`, `useReopenOrder`, `useBulkDeleteOrders`                                                                                                         |
| `invoices.ts`        | `useInvoices`, `useInvoice`, `useCreateInvoice`, `useUpdateInvoice`, `useSendInvoice`, `useVoidInvoice`, `useApplyCreditNote`, `useApplyAdvanceToInvoice`, `useDownloadInvoicePdf`, `useRecordInvoicePayment`, `useRecurringInvoices` |
| `routes.ts`          | `useRoutes`, `useRoute`, `useCreateRoute`, `useAddStopToRoute`, `useUpdateRoute`, `useRouteRuns`, `useCreateRouteRun`, `useOptimizeRoute`, `useAnalyzeRoute`                                                                          |
| `customers.ts`       | `useCustomers`, `useCustomer`, `useCreateCustomer`, `useUpdateCustomer`                                                                                                                                                               |
| `products.ts`        | `useProducts`, `useProduct`, `useProductByBarcode`, `useCreateProduct`, `useUpdateProduct`                                                                                                                                            |
| `drivers.ts`         | `useDrivers`, `useDriver`, `useCreateDriver`, `useUpdateDriver`, `useChangeDriverStatus`, `useDriverHistory`, `useDriverMetrics`                                                                                                      |
| `suppliers.ts`       | `useSuppliers`, `useSupplier`, `useCreateSupplier`, `useUpdateSupplier`, `useDeactivateSupplier`                                                                                                                                      |
| `returns.ts`         | `useReturns`, `useReturn`, `useCreateReturn`, `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`, `useMarkReturnReceived`, `useProcessRefund`                                                                            |
| `estimates.ts`       | `useEstimates`, `useEstimate`, `useCreateEstimate`, `useUpdateEstimate`, `useSendEstimate`, `useConvertEstimate`                                                                                                                      |
| `credit-notes.ts`    | `useCreditNotes`, `useCreditNote`, `useCreateCreditNote`, `useIssueCreditNote`, `useApplyCreditNote`, `useVoidCreditNote`                                                                                                             |
| `vendor-bills.ts`    | `useVendorBills` (+`needsMapping`, meta.needsMappingCount), `useVendorBill`, `useCreateVendorBill`, `useReceiveVendorBill` (`{id, acknowledgeUnlinked?}`), `getUnlinkedItemsError`                                                    |
| `finance.ts`         | `useFinanceDashboard`, `useArAgingInvoices`, `useSalesByCustomer`, `useSalesByItem`, `useProfitAndLoss`, `useCashFlow`, `useExpenses`, `useCreateExpense`, `useUploadExpenseReceipt`                                                  |
| `bookkeeping.ts`     | `useTransactions`, `useTransaction`, `usePayments`, `usePayment`                                                                                                                                                                      |
| `inventory.ts`       | `useStockOverview`, `useStockMovements`, `useRecordPurchase`, `useRecordAdjustment`, `usePurchaseOrders`, `useForecasting`, `useInventoryValuation`, `useSetCostBasis`, `useBulkSetCostBasis`, `useRecomputeCosts`                    |
| `order-templates.ts` | `useOrderTemplates`, `useOrderTemplate`, `useCreateOrderTemplate`, `useGenerateTemplateOrder`                                                                                                                                         |
| `buyers.ts`          | `useBuyerProducts`, `useBuyerOrder`, `useBuyerCreateOrder`, `useBuyerCancelOrder`, `useBuyerInvoice`, `useBuyerDashboard`, `useBuyerFavorites`, `useBuyerAnalytics`                                                                   |
| `users.ts`           | `useMe`, `useChangePassword`, `useUpdateProfile`                                                                                                                                                                                      |
| `notifications.ts`   | `useNotificationCount`, `useUnreadNotifications`                                                                                                                                                                                      |
