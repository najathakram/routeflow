## 9. Operator — Analytics & Tobacco Compliance

**Role(s):** Operator back-office. **Analytics** (`/analytics`) is available to `OPERATOR`, `TENANT_ADMIN`, and `SUPER_ADMIN` (impersonating) — never to `CUSTOMER` or `DRIVER` (they get a reduced nav and `RouteGuard` bounces them to `/dashboard`). **Tobacco** (`/tobacco`) is additionally **addon-gated** on `tobacco_dealer` and its Settings card is `TENANT_ADMIN`-only. • **Entered via:** the operator sidebar (`(dashboard)/layout.tsx`) — **Analytics** is a top-level leaf (`BarChart2` icon) sitting just below the Finance group; **Tobacco** is spliced in at runtime _immediately after_ the Analytics leaf (`Cigarette` icon) only when the tenant has the addon.

This is the operator's read-only business-intelligence surface (`/analytics` — revenue, product/inventory, customer, and operations analytics over a date range) plus the optional **Tobacco Dealer Compliance** module (`/tobacco` — separate tracking of tobacco purchases/sales/inventory with monthly tax reports and license validation). Both lean on Recharts for visualisation and share the app-wide money-display conventions; neither writes order/invoice data (Analytics is pure read; Tobacco writes only report artifacts + one settings flag).

---

### Screens

#### Analytics — `/analytics`

- **File:** `apps/web/app/(dashboard)/analytics/page.tsx`
- **Purpose:** One dashboard, four tabbed lenses on the business — Revenue, Products & Inventory, Customers, Operations — all scoped to a single **date range**. Every metric hits the tenant-scoped `apiClient` (`GET /analytics/*`) directly (no TanStack hooks here; raw `useEffect` + `apiClient.get`).
- **Global chrome (above the tabs):**
  - **`PageHeader "Analytics"`** with an inline **date-range picker** in its action slot: a `Calendar` icon, a **From** `<input type="date">` (capped `max={to}`), an en-dash, a **To** `<input type="date">` (`min={from}`), and an **Apply** button. Dates are held as _draft_ (`fromInput`/`toInput`) vs _applied_ (`appliedFrom`/`appliedTo`) — tabs only re-query on **Apply**.
  - **Date-preset pills** (row of rounded buttons, active preset highlighted `bg-brand-100`): **This Month**, **Last Month**, **This Quarter**, **YTD**. A preset applies immediately (sets both draft and applied). Default range on load = **Jan 1 of current year → today** (`getDefaultDates`).
  - **Tab bar** (`TabButton`, underline-on-active, horizontally scrollable): **Revenue** (`DollarSign`), **Products & Inventory** (`Package`), **Customers** (`Users`), **Operations** (`Truck`). Active tab id kept in local state (`revenue` default); **not** persisted to the URL.
- **Shows — Tab 1 · Revenue** (`RevenueTab`):
  - Four **StatCards**: **Total Revenue** (`usd`, summed client-side from the trend series), **Avg Order Value** (`GET /analytics/aov`), **DSO (Days)** (`GET /analytics/dso`, `.dso.toFixed(1)`), **Gross Margin** (`GET /analytics/gross-margin`, `grossMarginPct`).
  - **"Revenue Trend"** — Recharts **BarChart** (`GET /analytics/revenue?groupBy=month`); Y-axis compacts to `$Nk`, bars `#4F7FFA`, tooltip formats `usd`. Empty → "No revenue data for this period".
  - **"Gross Margin Breakdown"** — a definition list: Revenue, **COGS** (`text-danger`), **Gross Profit** (`text-success`), and a highlighted **Gross Margin %** row.
  - **"Sales by Category"** — Recharts **PieChart** (`GET /analytics/sales-by-category`), 8-colour palette, `% of total` labels, legend. Empty → "No category data for this period".
- **Shows — Tab 2 · Products & Inventory** (`ProductsInventoryTab`) — four `AnalyticsTable`s:
  - **"Top Products"** with a right-aligned **By Revenue / By Units Sold** `Select` (`GET /analytics/products/top?metric=&limit=10`). Columns: Product / Revenue / Units Sold.
  - **"Inventory Turnover"** (`GET /analytics/inventory/turnover`) — Product / Units Sold / Current Stock / **Turnover Rate** (`Nx`, colour-coded: ≥4 green, ≥1 navy, else warning).
  - **"Dead Stock"** (`GET /analytics/inventory/dead-stock`) — Product / Stock / **Last Movement** (date or "Never") / **Days Inactive** (`Nd`, >90 danger, >30 warning). Empty → "No dead stock items — great!".
  - **"Margin Alerts"** (`GET /analytics/inventory/margin-alerts`) — Product / Price / Cost / **Margin** pill (<10% danger + `AlertTriangle`, <20% warning, else success). Empty → "All products are within healthy margin thresholds".
- **Shows — Tab 3 · Customers** (`CustomersTab`):
  - Single **"Top Customers"** `AnalyticsTable` with a **By Revenue / By Order Count** `Select` (`GET /analytics/customers/top?metric=revenue|orderCount&limit=10`). Columns: rank # / Customer / Total Revenue / Orders. (This is the LTV/order-frequency lens — ranked customer revenue and order counts; there is no separate churn chart in code.)
- **Shows — Tab 4 · Operations** (`OperationsTab`) — two `AnalyticsTable`s:
  - **"Route Performance"** (`GET /analytics/routes/performance`) — Route / Total Runs / Completed / **Completion Rate** (mini progress bar + %, ≥90 green / ≥70 warning / else danger).
  - **"Driver Performance"** (`GET /analytics/drivers/performance`) — Driver / Total Deliveries / Completed / **Completion Rate** (same bar treatment). This is the on-time-%/route-efficiency/driver-metrics view.
- **Actions:** pick From/To → **Apply** (re-queries the active tab); click a **preset pill** (instant); switch **tabs**; toggle the **By Revenue/Units/Orders** `Select`s on Products & Customers. **No export button on this page** — CSV/print are wired for the separate `/finance/reports` surface (see _Business rules_), not the analytics dashboard.
- **States:**
  - **Loading:** per-widget skeletons — `StatCard` shimmer blocks, `ChartSkeleton` (animated bars) for charts, `TableSkeleton` for tables. Each metric loads independently (parallel `useEffect`s).
  - **Empty:** per-widget empty copy (quoted above); tables render an `emptyText` row.
  - **Error (fail-soft):** the primary series of each tab (`/revenue`, `/products/top`, `/customers/top`, `/routes/performance`, `/drivers/performance`) toasts "Failed to load …" on error; secondary metrics (`aov`, `dso`, `gross-margin`, `sales-by-category`, `turnover`, `dead-stock`, `margin-alerts`) **swallow errors** and fall back to `null`/`[]` so the dashboard still renders.
  - **Role gating:** CUSTOMER/DRIVER never see the Analytics nav leaf and are redirected off `/analytics` by `RouteGuard`.

#### Tobacco Compliance — `/tobacco`

- **File:** `apps/web/app/(dashboard)/tobacco/page.tsx` (data hooks in `apps/web/lib/api/tobacco.ts`)
- **Purpose:** The **Tobacco Dealer Compliance** add-on surface — track tobacco stock/purchases/sales _separately_ from the rest of the catalog, validate supplier/customer tobacco licenses, and generate downloadable monthly tax reports (CSV + PDF).
- **Gate (first thing the page does):** `useTenantAddons()` → `GET /tenants/me/addons`; `enabled = addons.includes("tobacco_dealer")`.
  - **While loading addons:** centered spinner.
  - **Addon OFF:** a full-page **empty/upsell state** — `ShieldAlert` icon, "**Tobacco compliance is not enabled**", and body copy: _"The Tobacco Dealer Compliance add-on tracks tobacco purchases, sales, and inventory separately and generates monthly tax reports. Contact your platform administrator to enable it."_ No tabs, no data fetches fire. (Belt-and-braces: the nav leaf is already withheld when the addon is off, so most users never reach this screen; a direct URL hit lands on this upsell.)
  - **Addon ON:** renders `<TobaccoDashboard/>` (below).
- **Shows (`TobaccoDashboard`, addon ON):**
  - **Header:** "Tobacco Compliance" + subtitle "Separate tracking of tobacco purchases, sales, and inventory · monthly tax reports".
  - **Four KPI cards** (current month, from `useTobaccoOverview` → `GET /tobacco/overview`): **Flagged Products** (`flaggedProductCount`), **Tobacco Inventory Value** (`inventory.totalValue`), **Purchases (this month)** (`purchases.totalValue`), **Sales / Tax (this month)** (`sales.totalValue` + a `+$X tax` sub-figure from `sales.totalTax`). Each shows `—` until the query resolves.
  - **"Monthly Purchases vs Sales (<year>)"** — Recharts grouped **BarChart** (`useTobaccoMonthly` → `GET /tobacco/monthly`) with three series: **Purchases** (`#f59e0b`), **Sales** (`#3b82f6`), **Tax collected** (`#10b981`); X-axis shows `MM` (slices the `YYYY-MM` month key), custom legend/tooltip relabel the raw `purchaseValue`/`salesValue`/`taxCollected` keys.
  - **Tab bar** (Radix `Tabs`, default `reports`): **Monthly Reports**, **Inventory**, **Purchases**, **Sales**.
- **Shows — Tab · Monthly Reports** (`ReportsTab`, `useTobaccoReports` → `GET /tobacco/reports`):
  - A **month picker** (`<input type="month">`, defaults to the **last fully-completed month**, `max` = that month) + **Generate / Regenerate** button (`RefreshCcw`) + helper text "Reports auto-generate on the 1st of each month for the month just ended."
  - A **reports table**: Period (`YYYY-MM` mono), **Status** (`Generated` success badge — with a `×N` regeneration-count chip when `generationCount > 1` — or `Failed` danger badge whose tooltip shows `errorMessage`), Purchases, Sales, Tax, **Ending Stock Value**, Generated (date), and a row-actions cell with **CSV** (`Download`) and **PDF** (`FileText`) links (only when `status === "GENERATED"`).
  - Empty → "No reports yet — generate one for a completed month above."
- **Shows — Tab · Inventory** (`InventoryTab`, `useTobaccoInventory` → `GET /tobacco/inventory`): table of tobacco-flagged products — **Product** (links to `/products/:id`, `(inactive)` suffix when not active), SKU (mono), **Stock** (`currentStock unit`), **Avg Cost** (weighted-average, `—` if null), **Value**. Empty → "No products flagged as tobacco yet — flag them from the product form."
- **Shows — Tab · Purchases** (`PurchasesTab`, `useTobaccoPurchases({from,to})` → `GET /tobacco/purchases`): a `RangePicker` (two `date` inputs, default Jan-1→today of current UTC year) over a table — Date, Product, **Supplier**, **License #** (`supplier.tobaccoLicenseNo` mono, `—` if absent), Reference, Qty, Unit Cost, **Value**. Empty → "No tobacco purchases in this range." _(This is the supplier-license-validation view — the license column surfaces which purchases came from a licensed supplier.)_
- **Shows — Tab · Sales** (`SalesTab`, `useTobaccoSales({from,to})` → `GET /tobacco/sales`): same `RangePicker` + a table — Date, **Invoice** (mono link → `/invoices/:invoiceId`), **Customer** (`businessName`), **License #**, Product, Qty, Subtotal, **Tax**. The **License #** cell is the compliance heart of the screen: it computes `noLicense = !customer.tobaccoLicenseNo` and `licenseExpired = tobaccoLicenseExpiry < now`, and when either is true renders an **amber warning pill** — **"No license"** (tooltip "Customer has no tobacco license on file") or **"Expired"** (tooltip "Customer's tobacco license is expired") — otherwise the plain license number. Empty → "No tobacco sales in this range."
- **Shows — Settings card** (`SettingsCard`, **`TENANT_ADMIN` only** — `user?.role === "TENANT_ADMIN"`, rendered _below_ the tabs): a single checkbox **"Exclude tobacco from main analytics"** (`useTobaccoSettings` / `useUpdateTobaccoSettings` → `GET`/`PATCH /tobacco/settings`) with sub-copy explaining it's **presentation-only** — revenue/top-products/customers/margins/AOV/inventory analytics stop counting tobacco items, but bookkeeping/P&L (and this page) always keep them.
- **Actions:** pick a month → **Generate / Regenerate** (`useGenerateTobaccoReport` → `POST /tobacco/reports/generate {year,month}`; toast on success/error, invalidates the reports list); **CSV / PDF** download (`fetchTobaccoReportUrl(id, fmt)` → `GET /tobacco/reports/:id/{csv|pdf}` → opens the signed `url` in a new tab; toast "No CSV/PDF available" on failure); set Purchases/Sales **date ranges**; click an **Inventory** product → product detail; click a **Sales** invoice → invoice detail; **toggle the exclude-from-analytics** checkbox (TENANT_ADMIN, invalidates both `tobacco.settings` and the whole `analytics` query key).
- **States:**
  - **Addon OFF:** the `ShieldAlert` upsell page (described in _Gate_) — nothing else renders, no tobacco queries fire.
  - **Loading:** addon-check spinner; per-tab skeletons (`h-24 animate-pulse` blocks); KPI cards show `—`.
  - **Empty:** per-tab empty copy (quoted above).
  - **Report status:** `GENERATED` (badge + download links, `×N` chip if regenerated) vs `FAILED` (danger badge, error tooltip, no download links).
  - **License warnings:** amber "No license" / "Expired" pills on the Sales tab (non-blocking — the sale still shows; it's a compliance flag, not a hard stop).
  - **Role gating:** the whole page is `OPERATOR`/`TENANT_ADMIN` only (nav leaf withheld from CUSTOMER/DRIVER **and** from the tobacco-splice branch); the Settings card is further `TENANT_ADMIN`-only.

---

### Key flows

- **View revenue analytics over a period:** sidebar **Analytics** → (optional) pick a **preset** pill or set From/To + **Apply** → **Revenue** tab reads Total Revenue / AOV / DSO / Gross Margin StatCards, the revenue-trend bar chart, the margin breakdown, and the sales-by-category pie → switch to **Products & Inventory / Customers / Operations** for the other lenses (re-scoped to the same range).
- **Find slow/at-risk inventory:** Analytics → **Products & Inventory** → scan **Dead Stock** (days-inactive) and **Margin Alerts** (sub-10% pills) → click through to the product (via `/products` — analytics itself is read-only).
- **Generate a monthly tobacco tax report:** sidebar **Tobacco** → **Monthly Reports** tab → the month picker is pre-set to the last completed month → **Generate / Regenerate** (`POST /tobacco/reports/generate`) → row appears with a `Generated` badge → **CSV** or **PDF** to download the filing artifact. Re-running the same month bumps the `×N` regeneration chip.
- **Validate a license on a tobacco sale:** Tobacco → **Sales** tab → set the date range → each row's **License #** column shows the customer's license, or an amber **"No license" / "Expired"** pill flagging a non-compliant sale → click the **Invoice** link to inspect the underlying sale. (Purchases tab does the equivalent for **supplier** licenses.)
- **Exclude tobacco from headline analytics (TENANT_ADMIN):** Tobacco → **Settings** card → tick **"Exclude tobacco from main analytics"** → `PATCH /tobacco/settings` → the main `/analytics` numbers (revenue, top products/customers, margins, AOV, inventory) stop counting tobacco while bookkeeping/P&L stay whole.

### Use cases

- As an operator, I want revenue/AOV/DSO/gross-margin at a glance for any date range so I can gauge business health. (Analytics → Revenue)
- As an operator, I want to see top products by revenue _or_ units, plus turnover, dead stock, and thin-margin alerts, so I can manage the catalog. (Analytics → Products & Inventory)
- As an operator, I want to rank customers by revenue or order count so I can spot my best (and lapsing) accounts. (Analytics → Customers)
- As an operator, I want route- and driver-completion rates so I can measure delivery reliability. (Analytics → Operations)
- As a tobacco dealer, I want tobacco stock/purchases/sales tracked separately and a downloadable monthly CSV/PDF for tax filing. (Tobacco → Monthly Reports)
- As a tobacco dealer, I want to see at a glance which sales went to unlicensed/expired-license customers so I stay compliant. (Tobacco → Sales, amber pills)
- As a tenant admin, I want tobacco to optionally drop out of my headline analytics without distorting my real books. (Tobacco → Settings)

### Business rules & edge cases

- **Addon gating (`tobacco_dealer`):** the Tobacco nav leaf is spliced into the sidebar **only** when `useHasAddon("tobacco_dealer")` is true _and_ the role isn't CUSTOMER/DRIVER (`(dashboard)/layout.tsx` ~L662-670). The page itself re-checks via `useTenantAddons()` and shows the `ShieldAlert` upsell when the addon is off — so a direct `/tobacco` URL never leaks data. **Analytics is NOT addon-gated** (available to any operator role).
- **Role gating:** CUSTOMER/DRIVER get `CUSTOMER_NAV`/`DRIVER_NAV` (no Analytics, no Tobacco) and `RouteGuard` redirects them off any disallowed path to `/dashboard` (`CUSTOMER_ALLOWED`/`DRIVER_ALLOWED` prefix lists exclude both `/analytics` and `/tobacco`). Tobacco's **Settings** card is gated a second time on `TENANT_ADMIN`.
- **Analytics date model:** draft vs applied dates — tabs only re-fetch on **Apply** (or a preset click, which applies instantly). Default = YTD (Jan-1 → today). All `apiClient.get` calls pass `{from, to}`; revenue also passes `groupBy: "month"`.
- **Fail-soft metrics:** analytics never blanks the whole page on one failed endpoint — primary series toast, secondary metrics silently return `null`/`[]`. Every widget has its own loading + empty state.
- **Report regeneration:** `POST /tobacco/reports/generate` is idempotent-by-period — re-running a month overwrites and increments `generationCount`, surfaced as a `×N` chip. Reports **auto-generate on the 1st** for the prior month; the picker defaults to and caps at the last completed month (can't generate the current, in-progress month).
- **Report status / downloads:** only `GENERATED` reports expose CSV/PDF links; `FAILED` rows show a danger badge with the `errorMessage` in a tooltip. Download resolves a signed URL (`GET /tobacco/reports/:id/{csv|pdf}` → `.url`) and opens it in a new tab; a missing artifact toasts "No CSV/PDF available".
- **License validation is advisory, not blocking:** Sales-tab pills flag `noLicense`/`licenseExpired` customers but don't prevent the sale from appearing; expiry is computed client-side (`new Date(expiry) < new Date()`). Purchases-tab surfaces the supplier license number for the same audit purpose.
- **Tax reporting:** the Sales tab and the monthly report track **tax collected** separately (`sales.totalTax`, `totalTaxCollected`, `taxCollected` chart series); the KPI card shows `+$X tax` alongside sales value.
- **Exclude-from-analytics is presentation-only:** flipping it invalidates the entire `["analytics"]` query cache so headline numbers refresh, but bookkeeping/P&L and the Tobacco page always reflect true financials (never hidden).
- **Money display:** analytics uses a local `usd`/`pct` formatter (`Intl.NumberFormat`); tobacco uses shared `fmt`/`fmtDate` (`lib/formatting.ts`). Neither page performs line-math — they render server-computed aggregates (server owns `pricing.ts` boxed proration).
- **e2e coverage:** `apps/web/e2e/02-operator.spec.ts` **OP-13** only asserts `/analytics` renders a chart/heading without erroring (smoke-level); there is no e2e for the tobacco module.

### Relevant files (all absolute)

- Pages: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\analytics\page.tsx`, `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\tobacco\page.tsx`
- Nav splice + role/route guards: `C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\layout.tsx` (Analytics leaf ~L109-111; tobacco splice ~L662-670; `getNavForRole` ~L138-161; `RouteGuard` ~L174-191)
- Tobacco data + addon flags: `C:\ClaudeCode\routeflow\apps\web\lib\api\tobacco.ts` (`useTenantAddons`, `useHasAddon`, `TOBACCO_ADDON`, overview/inventory/purchases/sales/monthly/reports/settings hooks, `useGenerateTobaccoReport`, `fetchTobaccoReportUrl`)
- Charts + export: `C:\ClaudeCode\routeflow\apps\web\components\ReportChart.tsx` (generic Recharts bar/pie/line/stacked wrapper used by `/finance/reports`; the analytics + tobacco pages inline their own Recharts instead), `C:\ClaudeCode\routeflow\apps\web\lib\report-export.ts` (`exportReportCSV`, `printReport`)
- Formatting: `C:\ClaudeCode\routeflow\apps\web\lib\formatting.ts` (`fmt`, `fmtShort`, `fmtDate`)
- API client: `C:\ClaudeCode\routeflow\apps\web\lib\api-client.ts`
- e2e: `C:\ClaudeCode\routeflow\apps\web\e2e\02-operator.spec.ts` (OP-13)
- Note: there is **no** `apps/web/lib/tobacco.ts` — the addon helpers referenced elsewhere live in `apps/web/lib/api/tobacco.ts`.

---

### 💡 Faster ways (redesign suggestions — NOT current behavior)

- **Scheduled report emails.** Reports already auto-generate on the 1st; let a tenant admin subscribe an email (or list) so the monthly tobacco CSV/PDF is _delivered_ rather than pulled. Same pattern could push a monthly analytics digest.
- **Drill-down from KPI/row to the underlying list.** Today analytics is a dead-end read (no links out). Make StatCards and table rows clickable — Top Customers → `/customers/:id`, Dead Stock → `/products/:id` (already a link in tobacco inventory; extend to analytics), Margin Alerts → the product edit form, Route/Driver rows → their detail pages.
- **Unified export.** Analytics has _no_ export at all while `report-export.ts` (`exportReportCSV`/`printReport`) already exists for `/finance/reports`. Add a single **Export** control to the analytics header (CSV of the active tab + a print/PDF of the whole dashboard) and let the tobacco Purchases/Sales tabs export their filtered ranges — one consistent export affordance everywhere.
- **Persist tab + range in the URL.** Analytics tab and date range are local state only; encoding them as query params would make dashboards shareable/bookmarkable and survive refresh.
- **Consolidate the two Recharts styling stacks.** `analytics/page.tsx` and `tobacco/page.tsx` each inline their own bar/pie config with hardcoded hex palettes, duplicating the generic `ReportChart.tsx`. The redesign should route all three through one themed chart primitive (brand-var-driven colours, shared tooltip/legend).
- **Surface license warnings proactively.** The "No license / Expired" flag only appears retrospectively on the Sales tab. Consider warning at order/invoice time (and a KPI count of non-compliant sales this month) so operators catch it before filing.
