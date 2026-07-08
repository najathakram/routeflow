# Area: api (`apps/api`)

NestJS 11 API with Prisma 7/PostgreSQL, tenant-scoped JWT auth, runs from compiled
`dist/main.js` on port 3000, global prefix `/api/v1`, multi-role (SUPER_ADMIN, TENANT_ADMIN,
OPERATOR, DRIVER, CUSTOMER), Redis queues & Socket.io.

> Side-effect/integration notes below are directional (grep-derived structure + inferred data
> flow). Verify against the code before relying on a specific external integration.

## Where to find (this area)

| Need                                     | File → symbol                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Auth login/register/JWT                  | `auth/auth.controller.ts` + `auth.service.ts` → `login(dto)`, `refresh()`, reset-password    |
| Tenant context isolation                 | `tenant/tenant-context.service.ts` → `get()`, `getOrNull()`, `isSuperAdmin()`                |
| Tenant scoping in Prisma                 | `prisma/prisma.service.ts` → `forTenant(tenantId)`, `tenantTransaction(fn)`                  |
| Rate limiting (100 req/60s)              | `app.module.ts` → `ThrottlerModule` + `common/redis-throttler.storage.ts`                    |
| Tenant status guard                      | `tenant/tenant-status.guard.ts` → blocks SUSPENDED/CANCELLED tenants globally                |
| Role-based access                        | `auth/guards/roles.guard.ts` → `@Roles(UserRole.DRIVER, ...)`                                |
| Config & secrets                         | `config/configuration.ts` → env, JWT, Redis, R2, storage signing (HKDF derived)              |
| Startup (migrations, secrets)            | `main.ts` → `assertSecrets()`, `runStartupMigration()`, CORS, helmet, trust proxy 2          |
| Encryption at rest                       | `common/encryption.service.ts` → encrypt/decrypt (refuses placeholder key in prod)           |
| File uploads/storage                     | `uploads/uploads.controller.ts` → multipart, disk write, HMAC-signed URLs                    |
| Platform admin (tenants, billing, audit) | `platform-admin/platform-admin.controller.ts` → stats, tenant CRUD, impersonation            |
| Buyer portal (multi-tenant identity)     | `buyer/buyer.controller.ts`, `buyer-auth.controller.ts` → register, link sellers, invites    |
| Orders & tracking                        | `orders/orders.controller.ts` → CRUD, status transitions, sweep-pending consolidation        |
| Routes & runs (driver)                   | `routes/routes.controller.ts` → stops, run completion, POD photos                            |
| Invoices                                 | `invoices/invoices.controller.ts` → from-order, payments, PDF, send-email, write-off         |
| Returns & refunds                        | `returns/returns.controller.ts` → approve/reject/in-transit/receive/refund                   |
| Customers                                | `customers/customers.controller.ts` → CRUD, tags, addresses, price overrides, documents      |
| Products & inventory                     | `products/products.controller.ts`, `inventory/inventory.controller.ts` → barcode, stock, POs |

## Bootstrap & cross-cutting

- **`src/main.ts`** — startup: `assertSecrets()` (JWT required), `runStartupMigration()`
  (idempotent TenantConfig columns), helmet, trust proxy 2 (Railway CDN), CORS wildcard
  patterns, global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform),
  ThrottlerExceptionFilter (429 + Retry-After), Swagger dev-only, graceful shutdown.
- **`src/app.module.ts`** — ConfigModule, PrismaModule, CommonModule, TenantModule, AuthModule,
  feature modules, BullModule (Redis queue), ScheduleModule (cron), ThrottlerModule (100/60s,
  Redis-backed). Global guards: `ThrottlerGuard`, `TenantStatusGuard`, `ImpersonationGuard`.
  Middleware: tenant resolution (extract tenant from JWT → AsyncLocalStorage context).
- **`src/prisma/prisma.service.ts`** — extends PrismaClient (PrismaPg adapter + Pool). Key:
  `getTenantId()` (reads TenantContextService), `tenantTransaction(fn)` (sets session var
  `app.current_tenant_id` for RLS), `forTenant(tenantId)` proxy that auto-filters queries by
  tenant. **Bare `this.prisma.<model>` bypasses scoping — load-bearing convention.**
- **`src/config/configuration.ts`** — env load: `DATABASE_URL`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET` (required, crash on missing), `ENCRYPTION_KEY` (optional 64-hex),
  `STORAGE_URL_SIGNING_SECRET` (HKDF-SHA256 derived from JWT_SECRET if unset).
- **`src/common/`** — `EncryptionService` (AES-256-GCM, refuses placeholder key writes in prod),
  `RedisThrottlerStorage` (cross-instance rate limit, fails closed), ThrottlerExceptionFilter,
  audit interceptor. **`pricing.ts`** — `computeLineSubtotal` (boxed BOX-price proration),
  `normalizeBoxesPieces` (integer boxes/pieces + rollover), `roundMoney` (cents). **Every money
  write rounds; boxed lines never use `qty*unitPrice` (over-charges by unitsPerBox).** Mirrored in
  web/mobile `lib/pricing.ts`. `utils/pricing.ts` = `getTierPrice`. **`computeCategoryTax`** (Phase-4 W3) — regulated per-category levy: per-unit types (EXCISE/PER_VOLUME/DEPOSIT) = `rate × unitBasisQty` (**caller converts to basis**: pieces for excise/deposit, true volume for PER_VOLUME — a 16oz bottle taxed per-oz needs 16×pieces; orthogonal to box-proration, never the boxed subtotal); PERCENT_OF_SALE = `rate × subtotal` (embedded when priceIncludesTax = `subtotal×rate/(1+rate)`). Sign-preserving (reversals). Pure fn — snapshot/integration + add-vs-include decision + PER_VOLUME volume-per-piece source deferred to W4. Specs: `common/pricing.spec.ts`.
- **Prisma `prisma/schema.prisma`** — models incl. Tenant, User, Customer, Driver, Product,
  Route, RouteStop, RouteRun, RouteRunStop, Order, OrderItem, Invoice, InvoiceItem,
  InvoicePayment, Payment, CreditNote, Estimate, VendorBill(+Item), Return(+Item),
  AdvancePayment, Supplier, StockLot, StockMovement, OrderTemplate, PurchaseOrder,
  DeliveryMutation, Transaction(+Item), Expense, ExpenseCategory, MileageRate, ContactPerson,
  Customer{Tag,Address,Document,Comment,Price}, Message, RecurringInvoice, BuyerAccount,
  CustomerLink, BuyerMergeRequest, SystemConfig, PlatformConfig, AuditLog,
  **TrackedCategory, CustomerAuthorization, AuthorizationOverride, RegulatedSalesLedger**
  (Phase-4 regulated items — migration `20260706120000_regulated_items_foundation`). All tenant-scoped.

## Feature modules (`src/<module>/`)

### `auth/`

- **controller** `auth` — `@Post login|refresh|logout|change-password|verify-email|request-password-reset|reset-password`, `@Get/@Delete sessions`. Google OAuth: `@Get google`, `@Post google/exchange` (single-use code handoff), `@Get google/:tenantSlug/callback`.
- **service** — `login`, `refresh`, `logout`, `changePassword`, `listSessions`, `requestPasswordReset`, `resetPassword`, `verifyEmail`; Google `getGoogleAuthUrl`, `exchangeGoogleCode`, `linkGoogleAccount`.
- side effects: User/PasswordResetToken/RefreshToken writes; reset email; JWT signing.

### `platform-google-auth/`

- **controller** `platform-admin/auth/google` — `@Get`, `@Get callback`, `@Get link` (SUPER_ADMIN Google sign-in). Config in TenantGoogleOAuth model.

### `users/`

- **controller** `users` — `@Post operator`, `@Get` list, `@Get me`, `@Patch me/preferences`, `@Get/:id`, `@Patch :id|:id/status|:id/admin|:id/driver-permit`, `@Post :id/reset-password`.
- **service** — `createOperator`, `findAll`, `findOne`, `update`, `updateStatus`, `updatePreferences`, `resetPassword`. side effects: User/UserPreference writes; audit on role/status change.

### `tenants/`

- **controller** `tenants` — `me/config/{email,google-oauth,branding}` GET/PUT, email test, branding logo upload. Public: `public/tenants`, `public/places` (geocode).
- side effects: TenantConfig/TenantGoogleOAuth writes; email send; logo upload to storage.

### `platform-admin/`

- **controller** `platform-admin` — `@Get stats|stats/growth|audit-logs|audit-logs/facets|billing/overview`, tenants CRUD, `@Patch tenants/:id/{config,status,plan}`, `@Post tenants/:id/{impersonate,extend-trial,activate-subscription,reset-admin-password}`, addons + billing checkout/portal. Mutation endpoints thread `@CurrentUser` adminId; addon enable/disable are async + audit-logged.
- **service** — tenant CRUD, `updateStatus`/`updatePlan` (invalidate TenantStatusGuard cache), `impersonate`, `getGrowthStats`, `getAuditLogs` (enriched: resolves actor `{username,email,isPlatform}` + tenant `{slug,name}` + friendly `actionLabel`), `getAuditLogFacets`, `recordAdminAction(tenantId,adminId,code,meta)`. Every lifecycle mutation + impersonation emits a purpose-built AuditLog row keyed to the TARGET tenant (entityType='tenant', structured code from `audit-actions.constant.ts`) so per-tenant audit filters surface platform actions — the generic AuditInterceptor still writes its `tenantId=null` row too. side effects: Tenant/TenantSubscription/TenantAddon writes; billing (Stripe) calls; AuditLog.
- **`audit-actions.constant.ts`** — `AdminAuditAction` codes + `ADMIN_AUDIT_ACTION_LABELS`/`ADMIN_AUDIT_ACTION_FACETS`/`adminAuditActionLabel()` (single source for the audit-log facets dropdown + human-readable labels). Spec: `platform-admin.service.spec.ts`.

### `customers/`

- **controller** `customers` — export, tags CRUD, merge, pending-portal-approvals; `me`/`me/statement`/`@Patch me`; per-id: status, routes, orders, statement, advance-payments, prices CRUD, addresses, contacts, comments, tax-documents, documents, portal invite/approve/disconnect; `DELETE :id` (soft-delete w/ `force`), **`POST :id/restore`** (server side of the 8s Undo).
- **service** — `findAll`, `findOne`, `create`, `update`, `updateStatus`, `getStatement`, `merge`, `add{Tag,Address,Contact,Price}`, `exportCSV`, portal flows; `deleteCustomer(force)` soft-deletes (sets `deletedAt` + deactivates user) preserving financial records, `restoreCustomer` reverses it (clears `deletedAt` + reactivates user, idempotent). side effects: Customer + related writes; portal-invite email; presigned doc URLs; ledger updates on price/advance changes. **`email` is OPTIONAL** (DTO `@IsOptional`): `create` mints a unique `no-email+<uuid>@placeholder.local` for the required `User.email` and leaves `Customer.email` null; `sendPortalInvite` ignores `@placeholder.local` fallbacks. Spec: `customers.service.spec.ts`.

### `drivers/`

- **controller** `drivers` — `me`/`@Patch me`/`me/location`; per-id: get/patch/status/delete, history, metrics.
- **service** — `findAll`, `findOne`, `create`, `update`, `updateStatus`, `updateLocation`, `getMetrics`, `getRouteHistory`. side effects: Driver/DriverLocation writes; Socket.io location broadcast.

### `products/`

- **controller** `products` — `barcode/:barcode`, `@Get/:id`, import, `@Delete clear-all|bulk|:id`, `@Patch :id`, images add/remove.
- **service** — `findAll`, `findByBarcode`, `findOne`, `create`, `update`, `delete`, `import`, `add/removeImage`. `create` defaults a new product's `costingMethod` to the tenant `costing.method` via `resolveCostingMethod()` (WEIGHTED_AVERAGE→AVCO; explicit DTO wins; unset tenant → schema default FIFO) — ProductsModule imports SystemConfigModule (pos-cost-roles §1). side effects: Product/ProductImage writes; image upload; inventory ledger.

### `orders/`

- **controller** `orders` (+ `route-runs`) — `active`, `price-history` (GET, OPERATOR, ?customerId → last-given price per product), `@Get/:id`, `:id/tracking`, `@Patch :id/status|items|urgent`, `:id/reopen`, `sweep-pending`, `force-consolidate/:customerId`, bulk/single delete; RouteRun stop complete.
- **service** — `findAll`, `findOne` (lineItems `orderBy createdAt asc` ⇒ new items render at bottom), `create`, `changeStatus(id,status,role)` (CUSTOMER can cancel PENDING), `updateOrderItems`, `markUrgent`, `reopen`, `sweepPending`, `forceConsolidate`, `getTracking`, `completeStop` (SALE recording **delegates to `InventoryService.recordSale`** in-tx — no inline SALE writes; OrdersModule imports InventoryModule), **`getCustomerPriceHistory(tenantId,customerId)`** (returns `Record<productId,{lastPrice,listPriceAtTime}>` — only lines with `originalPrice` set; used to pre-fill the price field when scanning). side effects: Order/OrderItem writes; Transaction ledger; notifications; invoice auto-create on DELIVERED (per-batch lines use `computeLineSubtotal` for boxed proration + `discount: 0` for overrides — never `qty*unitPrice`); delivery-mutation tracking.
  - **`updateOrderItems` replace vs merge (gotcha):** operator path picks `replaceAll = dto.replaceAll ?? allNewItems` (`allNewItems = items.every(no id)`). `replaceAll` ⇒ deleteMany + recreate (mobile full-list pattern); else merge — id-less items are CREATED (appended), absent items left untouched. **Web edit UI sends `replaceAll: false`** so an add-only diff doesn't wipe untouched lines (was the data-loss bug). Mobile omits the flag ⇒ legacy heuristic ⇒ replace-all. Customer/DRIVER use a separate always-replace branch.

### `routes/` & `route-optimization/`

- **routes controller** `routes` (+ `route-runs`) — customer-assignments, live, route get/patch/delete, stops add/reorder/remove; runs: `my-runs`, `my-stats` (declared before `:id`), get, stop complete / complete-with-payment, stop patch, run patch/status/delete.
- **service** — `findAll`, `findOne`, `create`, `updateRoute`, `addStop`, `reorderStops`, `deleteStop`, `createRun` (passes `podPhotoUrls: []`), `completeStop(runId,stopId,mutations,podPhotos)`, `completeWithPayment`, `updateRunStop`, `getMyRuns`, `getMyStats`, `updateRunStatus`, `reopenStop` — reverses deliveries with a **compensating positive-qty SALE carrying the original sale's unitCost** (so signed COGS nets to 0; NOT an un-costed ADJUSTMENT).
- **route-optimization controller** `route-optimization` — `:id/optimize`, `:id/analyze` (external optimizer suggests stop order).
- side effects: Route/RouteStop/RouteCustomer/RouteRun/RouteRunStop/DeliveryMutation writes; Socket.io broadcast; payment recording; inventory adjust on mutations.

### `invoices/`

- **controller** `invoices` — from-order(+/partial), payments (export/record/get/list), per-id: get/patch, send, send-email, send-reminder, void, revert-to-draft, unvoid, reopen, duplicate, pdf, write-off, payments CRUD, price-adjustment, delete.
- **service** — `findAll`, `findOne`, `createFromOrder`, `update`, `send`, `sendEmail`, `sendReminder`, `void`, `revertToDraft`, `unvoid`, `reopen`, `duplicate`, `generatePDF`, `recordPayment`, `voidPayment`, `priceAdjustment`, `writeOff`. **`buildInvoiceItemData`** prorates boxed lines and carries an order line's override as net `unitPrice` + `originalPrice` (strikethrough) with **`discount: 0`** — it must NOT re-derive a discount from `originalPrice` or the override double-counts (every consumer bills `computeLineSubtotal(unitPrice) − discount`); **`recomputeOrderFromInvoices(orderId)`** = backward sync (rebuilds the linked order's items+totals from the SUM of all non-void invoices), called from `update`/`priceAdjustment` when `orderId` set (inverse of `reconcileOrderDraftInvoice`). side effects: Invoice/InvoiceItem/InvoicePayment + linked Order writes; Transaction ledger; email; PDF; journal entries.
- **Regulated invoice split (Phase 4 W4)** — `createInvoiceFromOrder`/`createInvoiceFromOrderWithTenant` now **return `Invoice[]`** (contract change; callers `createSale` sends every sibling + returns primary, web hook `useCreateInvoiceFromOrder` typed `Invoice[]`). New `groupOrderLinesForInvoicing` partitions lines by resolved category (`OrderItem.trackedCategoryId ?? product.trackedCategoryId`) → a **standard group** (uncategorised + non-`SEPARATE_INVOICE` treatments, which fold in + `logger.warn`) first, then one group per `SEPARATE_INVOICE` category (name-sorted). New `createSplitInvoices` does the money: per-group subtotal, regular tax allocated proportionally with the **last group absorbing the rounding remainder** (Σ group tax == single-invoice tax exactly), category tax per group; numbering **base / -R1 / -R2** (one sequence number, derived suffixes), shared `invoiceGroupId` only when >1 group; bumps `invoicedQty` once/line. **Single-group orders are byte-identical to pre-W4.** `buildInvoiceItemData` snapshots `trackedCategoryId`+`categoryTaxAmount` onto the line. **Interim guard:** throws if a category has `rate>0` (category tax not yet in the ORDER total — tobacco is rate=0). Order snapshot in `orders.service.create` (`OrderItem.trackedCategoryId` + `Order.hasRegulated`). **DEFERRED follow-ups:** `completeStop` route-delivery split, multi-draft `reconcileOrderDraftInvoice`, order-total category-tax inclusion (lifts the guard), W5 ledger, credit-note sibling reversal, products DTO `trackedCategoryId` wiring, PER_VOLUME volume source.

### `credit-notes/`

- **controller** `credit-notes` — create, list, get, issue, apply, void.
- **service** — `create`, `findAll`, `findOne`, `issue`, `apply`, `void`. side effects: CreditNote writes; ledger entries; optional auto-apply to invoices.

### `returns/`

- **controller** `returns` — `@Get/:id`, approve, reject, in-transit, receive, refund, cancel.
- **service** — `findAll`/`findAllForUser(userId,role)` (CUSTOMER filtered), `findOne`, `create`, `approve`, `reject`, `markInTransit`, `receive` (RETURN movement restocks at current averageCost with unitCost+snapshots stamped), `refund`, `cancel`. side effects: Return/ReturnItem writes; RETURN movement on receive; credit-note auto-gen on refund; email.

### `order-templates/`

- **controller** `order-templates` — get/patch/delete, items add/remove, `:id/generate`.
- **service** — `findAll`, `findOne`, `update`, `delete`, `addItem`, `removeItem`, `generateOrder` (draft Order from template). side effects: OrderTemplate(+Item)/Order writes.

### `drafts/` (Minimize & resume, pos-cost-roles-spec §2)

- **controller** `drafts` — `/drafts` CRUD (`@Roles(OPERATOR, DRIVER)`; TENANT_ADMIN satisfies OPERATOR).
- **service** — `list`/`create`/`update`/`get`/`remove`; per-user ownership (`assertOwned`) + tenant-scoped (`forTenant()`); autosave upserts the same draft. Model **`SaleDraft`** (per-user, `payload` Json, additive migration `20260705120000_add_sale_drafts` — CREATE TABLE only; **apply to prod before the web dock deploys**). Spec `drafts.service.spec.ts`. Web: `components/DraftDock.tsx` + `CreateOrderModal` Minimize/resume.

### `inventory/`

- **controller** `inventory` — overview, movements (+purchase/adjustment), stock-count/commit, **valuation**, **`@Patch products/:id/cost-basis`**, **`@Post cost-basis/bulk`**, **`@Post recompute-costs`**, suppliers CRUD, purchase-orders CRUD + send/receive/close, forecasting.
- **service** — `getStockOverview`, `listMovements`, `recordPurchase`, `recordAdjustment`, `commitStockCount`, **`recordSale(productId,qty,ref,userId,tx)` — THE single sale-costing path** (per-method unitCost: AVCO=avg, FIFO/LIFO=lot blend w/ avg fallback, STANDARD=standardCost, **LAST_COST=most recent PURCHASE StockMovement unitCost (typed; `orderBy [createdAt desc, id desc]`), avg fallback, not lot-consuming — MUST use the PURCHASE movement not the latest StockLot, since adjustments/stock-counts create avg-cost lots that would poison last-cost**; writes SALE movement WITH unitCost + snapshots, decrements stock, consumes lots, returns `{unitCost, stockAfter}`; never throws on negative stock). `CostingMethod` enum incl. **LAST_COST** (additive migration `20260706040000_add_costing_last_cost`; selectable per-product; tenant-default→product propagation = follow-on, QUESTIONS.md #10), PO CRUD + receive (Decimal AVCO), `getForecasting` (signed SALE sums), **`setCostBasis`/`bulkSetCostBasis`** (COST_BASIS movement qty 0 + product.averageCost; optional applyToLots), **`recomputeCosts({productIds?,dryRun?})`** (replays movement history → rebuilds averageCost + backfills avgCostAfter/stockAfter snapshots; reports noHistory + stockDrift), **`getValuation`**. Backdated purchase/adjustment auto-replays the product in-tx.
- **`costing.ts`** — pure Decimal helpers (mirror of common/pricing.ts discipline, 4dp): `costDecimal`, `nextAverageCost` (stock≤0 ⇒ reset to unitCost), `reverseAverageCost` (**null = KEEP previous avg** when reversal empties stock — never zero the basis), `planLotConsumption`. Spec: `costing.spec.ts`. ALL inventory writers must go through these.
- **StockMovement snapshots**: every movement now stamps `avgCostAfter`/`stockAfter` (product state AFTER) — point-in-time avg cost = latest movement ≤ T. `MovementType.COST_BASIS` = audited manual cost set (qty 0). Migration `20260704000000_inventory_cost_accounting`.
- side effects: StockLot/StockMovement/PurchaseOrder(+Item)/Product.averageCost writes; ledger. Specs: `inventory.service.spec.ts`.

### `billing/`

- **controller** `billing` (+ `billing/webhook`) — tenant billing get, checkout, portal, ensure-customer; Stripe webhook.
- **service** — `initializeCheckout`, `createCustomerPortal`, `ensureStripeCustomer`, `handleWebhook`. `AddonService.hasAddon/getActiveAddons/enable/disable` = tenant feature flags (TenantAddon).
- **`addon.guard.ts` + `require-addon.decorator.ts`** — `@RequireAddon(key)` + AddonGuard. **GOTCHA: guards run BEFORE TenantInterceptor — AddonGuard must read `req.user.tenantId`, never `prisma.getTenantId()`** (ALS empty). Order: `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)`. SUPER_ADMIN (null tenantId) passes. Tenant-facing flag read: `GET /tenants/me/addons`.
- side effects: TenantSubscription/Invoice writes on payment; Stripe API; guard cache invalidation. Specs: `addon.guard.spec.ts`.

### `estimates/`

- **controller** `estimates` — create, list, get, send, accept, decline, convert-to-invoice, void.
- **service** — `create`, `findAll`, `findOne`, `send`, `accept`, `decline`, `convertToInvoice`, `void`. side effects: Estimate(+Item) writes; Invoice on convert; email.

### `vendor-bills/`

- **controller** `vendor-bills` — create, list (`?needsMapping=true` filter), scan-invoice, product-mappings CRUD, per-id get/patch/receive (body `{acknowledgeUnlinked?}` + @CurrentUser)/revert-to-draft/void/payments/delete, bulk delete.
- **service** — `create`, `findAll` (needsMapping filter = DRAFT + items none|some productId null; meta always carries `needsMappingCount`), `findOne`, `update`, **`receive(id,dto?,userId?)`** — throws `ConflictException({code:"UNLINKED_ITEMS", unlinkedItems})` for empty/unmapped bills unless `acknowledgeUnlinked` (warn-and-confirm, not silent skip); per linked item: `nextAverageCost` + **StockLot create** (reference=billNumber) + snapshot-stamped PURCHASE movement (fresh in-tx product read so multi-line same-product compounds), `recordPayment`, `revertToDraft`/`voidBill` — `reverseAverageCost` (**keeps avg when stock empties**, no more zeroing) + `reverseBillLots` (delete untouched / zero partially-consumed lots), `delete`, `scanInvoice` (OCR), product-mapping CRUD. side effects: VendorBill(+Item)/BillPayment/StockLot writes; inventory PURCHASE on receive; expense entries. Specs: `vendor-bills.service.spec.ts`.

### `tobacco/` (tobacco_dealer addon)

- **controller** `tobacco` — class-level `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` + `@RequireAddon("tobacco_dealer")`: overview, inventory, purchases (PURCHASE movements of `isTobacco` products w/ supplier `tobaccoLicenseNo`), sales (InvoiceItems on non-DRAFT/VOID/WRITTEN_OFF invoices w/ customer license, tax = subtotal×taxRate), monthly, reports list/generate/:id/{csv,pdf}, settings (GET; PATCH = TENANT_ADMIN, writes SystemConfig `tobacco.excludeFromMainAnalytics`, audit-logged).
- **`tobacco-report.service.ts`** — `generateForPeriod(year,month,{userId?})` (past months only): per-product rows + totals, ending stock = `currentStock − Σ(movements after periodEnd)` (SALE rows negative), ending value at CURRENT averageCost (disclosed); CSV + react-pdf PDF at deterministic keys `tobacco-reports/<tenantId>/<yyyy-MM>.{csv,pdf}`; upsert per (tenant,period) via findFirst+create/update (forTenant can't composite-upsert), `generationCount` bump + audit on regen. `@Cron("0 2 1 * *")`: active tenants ∩ active addons, per-tenant `tenantCtx.run`, idempotent skip, FAILED rows on error. Template `tobacco-report-pdf.tsx` (jest-mocked via moduleNameMapper like the invoice template).
- **Analytics exclusion** — see `analytics/` note; helper `tobaccoExclusionActive()` = addon active AND config key true. Schema: `Product.isTobacco`, `TobaccoReport`, `Supplier.tobaccoLicenseNo`, `Customer.tobaccoLicenseNo/Expiry` (migration `20260704100000_tobacco_compliance`). **Phase 4 (W1) generalizes `isTobacco` → `Product.trackedCategoryId` (FK to `TrackedCategory`); `isTobacco` is kept as a SHADOW column for one release, so all reads here still use it until W2 flips them.**

### tracked-categories / regulated (Phase 4 — generalizes tobacco)

- **Schema (W1, migration `20260706120000_regulated_items_foundation`)** — 4 new tenant-scoped models + 6 enums, all ADDITIVE:
  - **`TrackedCategory`** — tenant-defined regulated class (tobacco=seed row #1). Fields: `name`, `taxType` (EXCISE_PER_UNIT|PERCENT_OF_SALE|PER_VOLUME|DEPOSIT_PER_CONTAINER|NONE), `rate` Decimal(12,4), `unitBasis`, `priceIncludesTax`, `invoiceTreatment` (SEPARATE_INVOICE|SEPARATE_SECTION|LINE_TAX), `appliesScope` Json, `requiresLicense`, `reportTemplate`, `reportCadence`, `active`. `@@unique([tenantId,name])`.
  - **`CustomerAuthorization`** — per-customer, per-category license state for one seller. `status` (NONE|PENDING_REVIEW|VERIFIED|EXPIRED|REJECTED), `source` (RETAILER_SUBMITTED|WHOLESALER_ADDED), `licenseNumber`, `expiresAt`, `documentKey`, `verifiedBy{Id,Name}/At` (FK-less actor SNAPSHOT). `@@unique([customerId,trackedCategoryId])`.
  - **`AuthorizationOverride`** — seller "sold under responsibility" audit record (`scope`, `reason`, `acknowledgedTenant`, `acceptedBy{Id,Name}/At`); append-only, FK-less actor snapshot survives user deletion.
  - **`RegulatedSalesLedger`** — immutable per-line regulated-sales ledger (source of truth for filings). `entryType` (SALE|REVERSAL, amounts negative on reversal), order/invoice/invoiceItem/creditNote pointers (plain, no FK), `qty`, `unitBasisQty`, `netSales`, `categoryTax`, `soldAt`, `periodBucket` ("YYYY-MM").
  - **New columns**: `Product.trackedCategoryId` (FK, SetNull); `OrderItem`/`InvoiceItem`.{`trackedCategoryId`(FK,SetNull),`categoryTaxAmount`}; `Invoice.invoiceGroupId` (paired siblings); `Order.hasRegulated`; `RouteRunStop.{ageCheckRequired,identityCheckRequired}`.
  - **Backfill** (in-migration, idempotent): one Tobacco category per tenant with `isTobacco` products; link those products; flag orders with a tobacco line `hasRegulated`. Tobacco seed = `taxType=NONE` + `requiresLicense=false` (**exact current warn-only behavior preserved** — enabling tax/license is an explicit W2/W6 per-tenant action, never an auto-flip), CA_CDTFA/MONTHLY.
- **`tracked-categories/` module (W2, wired)** — CRUD for `TrackedCategory`, tenant-scoped via `prisma.forTenant()`, guard `@UseGuards(JwtAuthGuard, RolesGuard) @Roles(OPERATOR)` (TENANT_ADMIN satisfies OPERATOR; no addon gate — generic feature). Routes: `GET /tracked-categories` (search + active filter, returns each w/ `productCount`), `GET /:id`, `POST /` (injects tenantId; P2002→409), `PATCH /:id`, `PATCH /:id/toggle` (flip active), `POST /:id/products/assign` + `/unassign` (bulk set/clear `Product.trackedCategoryId` via `updateMany`). **Assign sets ONLY the generic pointer — `isTobacco` stays owned by the product flow this release, so tobacco reports are unaffected.** Web hooks `apps/web/lib/api/tracked-categories.ts` (TanStack: `useTrackedCategories`/`useTrackedCategory`/`useCreate|Update|Toggle`/`useAssign|UnassignProductsToCategory`). Spec `tracked-categories.service.spec.ts`. Prisma-mock gained the 4 Phase-4 models.
- **`regulated/` module (W5a, wired)** — the regulated-sales ledger. `regulated-ledger.service.ts`: **`writeSaleEntries`** (one `RegulatedSalesLedger` SALE row per REGULATED invoice line, built from the created `invoice.items` so `invoiceItemId` is real; `netSales`=line subtotal, `categoryTax`=snapshot [0 today]; `periodBucket`=UTC YYYY-MM of `issueDate`; skips standard lines + null-tenant) hooked into `invoices.service.createSplitInvoices`; **`reverseInvoiceEntries`** (negated REVERSAL row per prior SALE, idempotent via already-reversed `invoiceItemId` set, books into current period) hooked into `voidInvoice` + `deleteInvoice` (inside their `tenantTransaction`). **W5c: `reverseReturnEntries`** (return→ledger: bridges ReturnItem.productId→InvoiceItem→SALE rows by `orderId`, PRO-RATES partial returns off the SALE snapshot with a closing-chunk exact-balance so a fully-returned line nets to 0, idempotent per `returnId` [new nullable column], subtracts prior reversals so cumulative ≤ sold; ignores `restock`) + **`unreverseReturnEntries`** (delete on cancel) hooked into `returns.service` `receive()`/`cancel()`; both `receive`/`cancel` gained an atomic `updateMany`-status CLAIM to serialize concurrent calls (no double-reverse/double-restock). `regulated.service.getLedger` = `GET /regulated/ledger?category=&from=&to=` (forTenant groupBy category+period, `_sum` of pre-signed amounts nets SALE+REVERSAL). `period.ts` = `periodBucketOf`/`monthRange`. Controller `@Roles(OPERATOR)`, no addon gate. Spec `regulated-ledger.service.spec.ts`.
  - **`regulated-filing.service.ts` (W5b, wired)** — the generic superset of `tobacco-report.service`. **`prepareFiling`** ((re)generates the filing for a PAST period: past-period guard on `to`; resolves cadence from param or `category.reportCadence`; `regulated.getLedger(..., {exclusiveTo:true})` for an EXACT half-open `[from,to)` window; filters rows to the `filingPeriod` bucket set [honors per-period netting]; sums pre-signed nets [never re-signs/clamps — reversal-heavy period nets negative]; `roundMoney` money + `roundQty` 3dp so JSON rows == DB Decimal == CSV; `findFirst`+create/update upsert with **P2002 retry-as-update**; audit `regulated_filing.prepared`); **`listFilings`**, **`downloadUrl`** (presigned CSV). `filing-csv.ts` = `buildFilingCsv` (reportTemplate-driven columns CA_CDTFA/CA_ABC/CALRECYCLE/GENERIC-fallback + coverage disclosure footer). `period.ts` gained **`filingPeriod`** (MONTHLY/QUARTERLY/ANNUAL → periodKey + buckets + UTC `[from,to)`). Routes `GET /regulated/filings`, `POST /regulated/filings/prepare`, `GET /regulated/filings/:id/{csv,pdf}`. Model `RegulatedFiling` (`@@unique[tenantId,trackedCategoryId,periodKey]`, FK `onDelete:Restrict`), migration `20260707120000_add_regulated_filing` (additive). Web: filing hooks in `tracked-categories.ts` + compliance-hub "Prepare filing" + filings list. **Uploads** now tenant-scope `regulated-filings/`+`tobacco-reports/` prefixes (JWT path). Specs: `regulated-filing.service.spec.ts`, `filing-csv.spec.ts`, `period.spec.ts`, `regulated.service.spec.ts`, `uploads-tenant-scope.security.spec.ts`.
  - **DEFERRED (W5c credit-note + follow-ups):** credit-note reversal SCHEMA-BLOCKED — CreditNote is header-only, needs `CreditNoteItem` or allocatable-only scoping (returns reversal is DONE); ReturnItem→line linkage (product on both regulated+non-regulated line reverses approximately); `reconcileOrderDraftInvoice`/manual-create/partial/draft-update ledger sync; `orderItemId` provenance; `unitBasisQty` conversion; filing cron; compliance-hub `/regulated/ledger` KPI wiring.
- **`authorizations/` module (W6a, wired)** — customer authorization lifecycle + regulated-sale license guard + §8 override. `authorizations.service` (lifecycle `create`[WHOLESALER_ADDED→VERIFIED, upsert+P2002 retry], `approve`/`reject`[PENDING_REVIEW only], `renew`[VERIFIED/EXPIRED only — blocks laundering], `findForCustomer`; **W6b: `submit`[buyer self-serve → RETAILER_SUBMITTED/PENDING_REVIEW, same upsert+P2002, clears verifier snapshot, refuses to clobber a live VERIFIED row, notifies seller operators push+email, audits `regulated_authorization.submitted` w/ shareConsent] + `listForBuyer`[every requiresLicense category ⟕ buyer's row → status NONE/lazy-EXPIRED]**; validates customer+category belong to tenant; immutable verifier snapshot). Now injects Notifications+Email; **module exports `AuthorizationsService`** (was guard-only) for buyer reuse. `authorization-overrides.service` (§8 `createOverride`[append-only row + AuditLog], `isOverrideActive`[scope parse]). `authorization-guard.service` **`checkAuthorized`/`assertAuthorizedOrThrow`** — the enforcement: for each line's `requiresLicense` category, customer needs a VERIFIED non-expired auth OR active override, else structured 409 `REGULATED_AUTH_REQUIRED`. **Tobacco (requiresLicense=false) is NEVER gated** (warn-only preserved — the release gate). Lazy expiry (`expiresAt<now`). `authorization-scope.ts` = `isScopeActive`(ORDER/UNTIL, fail-CLOSED) + `scopeApplies`(city geo, fail-CLOSED on unknown city). Controller `@Controller("customers/:customerId")` `@Roles(OPERATOR)`: `GET/POST authorizations`, `POST authorizations/:id/{approve,reject,renew}`, `POST authorization-overrides`. **Guard hooks in `orders.service`**: `create()` (before stock tx), `updateOrderItems()` (edit/buyer-merge — before mutation), `changeStatus()` (DRAFT→live promotion) — all non-draft, orderId passed for ORDER-scoped overrides. No migration (W1 models). Specs: `authorization-{guard,scope}.spec`, `authorizations.service.spec`, `authorization-overrides.service.spec` + orders guard-block tests.
  - **`authorization-expiry.service` (W7 part 1, wired)** — daily `@Cron("0 3 * * *")` `runExpirySweep` (mirrors tobacco cron: active tenants w/ ≥1 requiresLicense category, each inside `tenantCtx.run`). `processTenant` flips VERIFIED past-`expiresAt` → EXPIRED (guard already lazy-blocks; makes status truthful + audits `regulated_authorization.expired`) and sends 30/7/1-day expiring-soon warnings to buyer (`sendToCustomer`) + operators (`sendToUser`+email). Idempotency via `CustomerAuthorization.expiryNotifiedAt` + `expiringSoonNotifiedBucket` (re-fires only as bucket shrinks; reset on create/approve/renew). Tobacco (requiresLicense=false) never swept. Migration `20260709000000_add_authorization_expiry_notify` (2 nullable cols + `[status,expiresAt]` index, additive). Spec `authorization-expiry.service.spec`.
  - **Buyer visibility gate (W7 part 3, wired)** — `buyer-catalog.service.computeGate` (2 batched queries, no N+1) hides `requiresLicense` categories the buyer has no VERIFIED-non-expired auth for (predicate matches the sale guard). `getCatalog` excludes them via `products.service.findAll(query, {excludeTrackedCategoryIds})` (query-level → correct pagination) + returns `hiddenCategories`; `getProductDetail` 404s a locked deep-link; `getFavorites` filters. Fast-paths empty for non-regulated tenants. Spec `buyer-catalog.service.spec`. **DEFERRED (W7b): POD age/identity check at regulated delivery** (routes.service completeStop enforcement + `TrackedCategory.requiresAgeCheck/requiresIdCheck` + `RouteRunStop` verification cols + `CompleteStopDto`) — touches the delivery flow, do fresh; plus W7 web/mobile surfaces (buyer unlock tile, operator/buyer expiry bell).
  - **Buyer authorizations endpoint (W6b, wired)** — `buyer.controller` `GET/POST /buyer/authorizations` (seller-scoped: `BuyerSellerContextGuard` + `BuyerTenantInterceptor`; `customerId` from `@CurrentBuyerCustomer()` ctx, never the client) → `authorizations.service.listForBuyer`/`submit`. `BuyerModule` imports `AuthorizationsModule`. DTO `submit-authorization.dto` (license#+expiry required, `shareConsent` must be true). No migration (W1 models). Specs: buyer submit/list cases in `authorizations.service.spec`, delegation cases in `buyer.controller.spec`. **Per-seller by design** — `TrackedCategory` is per-tenant so one submission can't fan out across sellers; each connected seller verifies independently (spec §8), reached via the portal seller switcher.
  - **Invoice-time backstop (W6b, wired)** — the license guard re-runs in `invoices.service.createSplitInvoices` (inside the tx) to catch a regulated line added via buyer-merge after order creation and a license that EXPIRED between order creation and invoicing. See `invoices/` entry.
  - **Still DEFERRED:** license-document upload on both operator + buyer sides (`documentKey` optional/unwired — matches operator create); §8 create-path override post-create binding (run guard inside the order tx to get orderId); geo `deliveryCity` threading into the create hook; cross-seller license propagation (needs a cross-tenant category-identity concept).
- **Not yet wired** (later W-blocks): W7 expiry cron/POD/buyer-gate; product-form picker + scope selector. See `docs/design-package/PHASE-4-PLAN.md`.

### `recurring-invoices/`

- **controller** `recurring-invoices` — CRUD + `:id/run`.
- **service** — `create`, `findAll`, `findOne`, `update`, `delete`, `run`, `runScheduled` (cron). side effects: RecurringInvoice(+Item)/Invoice writes on run.

### `bookkeeping/`

- **controller** `bookkeeping` — summary, dashboard, transactions (+/:id, payments, pdf), expense-categories CRUD, mileage-rates CRUD, expenses (+bulk, batch-status).
- **service** — `getSummary`, `getDashboard`, `getTransactions`, `getTransaction`, `recordPayment`, `recordExpense`/`recordBulkExpenses`, expense-category + mileage-rate CRUD. side effects: Transaction(+Item)/Expense/ExpenseCategory/MileageRate writes; PDF.

### `analytics/`

- **controller** `analytics` — overview, revenue, top products/customers, route/driver performance, inventory turnover/dead-stock/margin-alerts, dso, sales-by-category, gross-margin, aov, price/cost history.
- **service** — corresponding read aggregates. **COGS/units are SIGNED sums of SALE rows (`-quantity`), never abs()** — reopen-reversals are positive SALE rows that must net out (same in bookkeeping P&L + inventory forecasting). `getCostHistory` includes COST_BASIS + returns `{unitCost, avgCostAfter, type}`. **Tobacco exclusion toggle** (`tobaccoExclusionActive()` = tobacco_dealer addon + SystemConfig `tobacco.excludeFromMainAnalytics`): excludes tobacco items from revenue/top-products/top-customers/sales-by-category/gross-margin/aov/turnover/dead-stock/margin-alerts — NOT bookkeeping/P&L/DSO/route-driver perf. side effects: read-only. Specs: `analytics.service.spec.ts`.

### `suppliers/`

- **controller** `suppliers` — get/patch/deactivate/delete.
- **service** — `findAll`, `findOne`, `create`, `update`, `deactivate`, `delete`. side effects: Supplier writes; ContactPerson updates.

### `notifications/` & `messages/`

- **notifications controller** `notifications` — register-token, delete token, test, status. `sendNotification`/`broadcast` via FCM/Expo push; DeviceToken writes.
- **messages controller** `messages` — create, list (inbox). Message writes; Socket.io broadcast.

### `uploads/`

- **controller** `uploads` — `@Get *path` (HMAC-verified presigned fetch); multipart upload.
- **service** — `uploadFile`, `generatePresignedUrl`, `verifyPresignedUrl`. side effects: file I/O to `/data/uploads` (Railway volume); HMAC via `STORAGE_URL_SIGNING_SECRET`.

### `system-config/` (settings)

- **controller** `system-config`/`settings` — config get/patch, anthropic, email (+test), route, invoice, delete financial-data.
- **service** — config CRUD, AI endpoint config, email test, `deleteFinancialData`. side effects: SystemConfig/TenantConfig writes.

### `import/`

- **controller** `import` — contacts, invoices, payments, expenses (+ batches, repair-inventory, batch delete), products, inventory, expense-suppliers, contacts mark-supplier-only / orphans / adopt-orphans.
- **service** — bulk importers + batch management. side effects: bulk Customer/Invoice/Payment/Expense/Product/Supplier/StockMovement writes; rollback on validation error; audit trail.
- **Migration & Batch Import — Phase 1 (numbering continuity, migration-import-spec §1):** `numbering.controller` (`GET/PUT /import/numbering`, `@Roles(OPERATOR)`) + **`NumberingService`** (exported). Owns per-tenant `NumberingSequence` (docType `INVOICE|ESTIMATE|CREDIT_NOTE|PAYMENT`, prefix/nextNumber/padding; `@@unique([tenantId,docType])`; plain `tenantId` scalar, no FK). Methods: `getSettings`/`updateSettings` (upsert), `seedFromSource` ("INV-08841"→next "INV-08842"), `parseDocumentNumber`, `format`, `peekNext`, **`reserveNext(docType, exists?)`** — atomic-increment fast path; collision-guarded path skips past existing numbers and **throws** at the 10k cap (never returns an unverified number), `advanced` flag for the "numbering advanced past an imported invoice" notice. **DEFERRED cross-module:** wiring `reserveNext` into live invoice/order minting (off-limits modules) — run it at SERIALIZABLE / `SELECT … FOR UPDATE`; imported docs keep ORIGINAL numbers and must NOT call it. Migration `20260708000000_import_numbering_sequences` (additive; `*.sql` is gitignored → `git add -f`). Web: `apps/web/lib/api/numbering.ts` + Document-numbering card on `settings/import/page.tsx`. Spec `numbering.service.spec.ts`.
- **Migration & Batch Import — Phases 2-5 (migrations `20260708010000`–`040000`, all additive):**
  - **P2 idempotency substrate:** `ExternalRefService` (`ImportExternalRef` side-table upsert by (source,externalId)→entityId, keeps off-limits finance models untouched), `ProductAliasService` (tenant-scoped `ProductAlias`, `""`=any-supplier sentinel, self-healing resolve drops dangling product pointers; fixes the old global `ProductMapping` cross-tenant bug), `DuplicateMatchService.findInvoiceDuplicate` (secondary match: normalized number + total±cent + issueDate±1d, read-only over Invoice). `AliasController` = `GET/POST/DELETE /import/aliases`. All exported.
  - **P3 variant resolution:** `Product.detailsIncomplete` col + `VariantResolutionService` (`createVariant` inherits parent family defaults via `ProductsService.create`; `createBrandNew` sells at cost×1.3, flags detailsIncomplete; `matchExisting` learns an alias; `listIncomplete`/`completeSetup`). `ResolutionController` = `/import/resolution/{variant,brand-new,match,incomplete,:id/complete}`. Web Finish-setup card on `settings/import`. (imports `ProductsModule`.)
  - **P4 migration staging + 24h undo:** `MigrationService` (`MigrationJob`+`MigrationStagingRecord`; `createJob`→`stageRecords` [dedup flags via ExternalRef+DupMatch]→`confirmJob` [commits PRODUCT/SUPPLIER via committers, records ExternalRef, undoDeadline=+24h]→`undoJob` [**atomic tenantTransaction**; deletes created rows + drops ExternalRefs; an in-use row rolls back with ConflictException]). CUSTOMER/INVOICE/PAYMENT committers deferred (reuse CSV importers). `SourceConnectorRegistry` = OAuth stub (CSV/paper direct; Zoho/QB throw upload-CSV). `MigrationController` = `/import/migration` (+ `:id/{stage,confirm,undo}`). Web migration hub + import history + products-CSV stage on `settings/migration`.
  - **P5 batch queue:** `BatchImportService` (`ImportBatch`+`ImportQueueItem`; `scanAndRecord` calls `vendorBills.scanInvoice` → classify CLEAN/NEEDS_REVIEW/DUPLICATE/FAILED [unmatched via line.**matchedProductId**; CLEAN needs all matched lines high-confidence; dup via DupMatch on invoiceDate]; `postBatch` maps scan lines matchedProductId→productId then `vendorBills.create`+`receive` per clean item [stock+cost]; `resolveItem`). `BatchController` = `/import/batch` (+ `:id/{scan,post}`, `items/:id/resolve`). Web queue on `settings/batch-import`. **DEFERRED:** background worker (Bull), scan-meter cap (billing). Specs: `{external-ref,product-alias,duplicate-match,variant-resolution,migration,batch-import}.service.spec.ts` (51 import tests).

### `audit/`

- **module** — global, no controller. `AuditService.log(userId, action, resource, resourceId, before?, after?, changes?)` → AuditLog writes. Injected by other modules.

### `buyer/` (multi-tenant customer identity)

- **buyer-auth controller** `buyer/auth` — register, login, refresh, logout, delete account, change-password, profile, sessions.
- **buyer controller** `buyer` — sellers, invites details/accept, sellers request/disconnect, profile, orders, invoices(+/:id), statement, products(+categories/:id), orders active/:id.
- **buyer-admin controller** `platform-admin/buyer-accounts` + `customer-links` — manage buyer accounts, approve links.
- **buyer-merge controller** `buyer/auth` — account merge via token.
- side effects: BuyerAccount/BuyerRefreshToken/CustomerLink/BuyerMergeRequest writes; invite email; presigned links.

### `email/`

- **module** — global. `EmailService.sendEmail(to,templateId,data)` + `sendReset`/`sendInvoice`/`sendOrderConfirmation`. Provider-agnostic (Sendgrid/Zoho/SMTP). SSRF guard on tenant SMTP host/port.

### `gateways/` (Socket.io)

- **module** — global. `broadcast{RouteUpdate,LocationUpdate,OrderUpdate}`, `notifyUser`. Redis adapter pub/sub to connected clients.

## Reference — enums (directional; verify in `schema.prisma` / `packages/types`)

UserRole(SUPER_ADMIN, TENANT_ADMIN, OPERATOR, DRIVER, CUSTOMER) · TenantStatus(TRIAL, ACTIVE,
SUSPENDED, CANCELLED) · OrderStatus(DRAFT, PENDING, CONFIRMED, OUT_FOR_DELIVERY,
PARTIALLY_DELIVERED, DELIVERED, CANCELLED) · RouteRunStatus(SCHEDULED, IN_PROGRESS, COMPLETED,
CANCELLED) · InvoiceStatus(DRAFT, SENT, VIEWED, PARTIAL, PAID, OVERDUE, VOID) ·
EstimateStatus(DRAFT, SENT, ACCEPTED, DECLINED, CONVERTED) · ReturnStatus(PENDING, APPROVED,
REJECTED, IN_TRANSIT, RECEIVED, REFUNDED, PROCESSED, CANCELLED) · VendorBillStatus(DRAFT,
RECEIVED, PARTIAL, PAID, OVERDUE, VOID) · PaymentMethod(CASH, CHECK, ACH, OTHER, CREDIT_NOTE,
ADVANCE, CREDIT_CARD) · MovementType(PURCHASE, SALE, ADJUSTMENT, RETURN, WRITE_OFF) ·
CreditNoteStatus(ISSUED, APPLIED, VOID).
