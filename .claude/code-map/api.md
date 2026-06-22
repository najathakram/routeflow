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
  web/mobile `lib/pricing.ts`. `utils/pricing.ts` = `getTierPrice`. Specs: `common/pricing.spec.ts`.
- **Prisma `prisma/schema.prisma`** — models incl. Tenant, User, Customer, Driver, Product,
  Route, RouteStop, RouteRun, RouteRunStop, Order, OrderItem, Invoice, InvoiceItem,
  InvoicePayment, Payment, CreditNote, Estimate, VendorBill(+Item), Return(+Item),
  AdvancePayment, Supplier, StockLot, StockMovement, OrderTemplate, PurchaseOrder,
  DeliveryMutation, Transaction(+Item), Expense, ExpenseCategory, MileageRate, ContactPerson,
  Customer{Tag,Address,Document,Comment,Price}, Message, RecurringInvoice, BuyerAccount,
  CustomerLink, BuyerMergeRequest, SystemConfig, PlatformConfig, AuditLog. All tenant-scoped.

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

- **controller** `platform-admin` — `@Get stats|stats/growth|audit-logs|billing/overview`, tenants CRUD, `@Patch tenants/:id/{config,status,plan}`, `@Post tenants/:id/{impersonate,extend-trial,activate-subscription,reset-admin-password}`, addons + billing checkout/portal.
- **service** — tenant CRUD, `changeStatus`/`changePlan` (invalidate TenantStatusGuard cache), `impersonate`, `getGrowthStats`, `getAuditLogs`. side effects: Tenant/TenantSubscription/TenantAddon writes; billing (Stripe) calls; AuditLog.

### `customers/`

- **controller** `customers` — export, tags CRUD, merge, pending-portal-approvals; `me`/`me/statement`/`@Patch me`; per-id: status, routes, orders, statement, advance-payments, prices CRUD, addresses, contacts, comments, tax-documents, documents, portal invite/approve/disconnect.
- **service** — `findAll`, `findOne`, `create`, `update`, `updateStatus`, `getStatement`, `merge`, `add{Tag,Address,Contact,Price}`, `exportCSV`, portal flows. side effects: Customer + related writes; portal-invite email; presigned doc URLs; ledger updates on price/advance changes.

### `drivers/`

- **controller** `drivers` — `me`/`@Patch me`/`me/location`; per-id: get/patch/status/delete, history, metrics.
- **service** — `findAll`, `findOne`, `create`, `update`, `updateStatus`, `updateLocation`, `getMetrics`, `getRouteHistory`. side effects: Driver/DriverLocation writes; Socket.io location broadcast.

### `products/`

- **controller** `products` — `barcode/:barcode`, `@Get/:id`, import, `@Delete clear-all|bulk|:id`, `@Patch :id`, images add/remove.
- **service** — `findAll`, `findByBarcode`, `findOne`, `create`, `update`, `delete`, `import`, `add/removeImage`. side effects: Product/ProductImage writes; image upload; inventory ledger.

### `orders/`

- **controller** `orders` (+ `route-runs`) — `active`, `price-history` (GET, OPERATOR, ?customerId → last-given price per product), `@Get/:id`, `:id/tracking`, `@Patch :id/status|items|urgent`, `:id/reopen`, `sweep-pending`, `force-consolidate/:customerId`, bulk/single delete; RouteRun stop complete.
- **service** — `findAll`, `findOne`, `create`, `changeStatus(id,status,role)` (CUSTOMER can cancel PENDING), `updateItems`, `markUrgent`, `reopen`, `sweepPending`, `forceConsolidate`, `getTracking`, **`getCustomerPriceHistory(tenantId,customerId)`** (returns `Record<productId,{lastPrice,listPriceAtTime}>` — only lines with `originalPrice` set; used to pre-fill the price field when scanning). side effects: Order/OrderItem writes; Transaction ledger; notifications; invoice auto-create on DELIVERED (per-batch lines use `computeLineSubtotal` for boxed proration + `discount: 0` for overrides — never `qty*unitPrice`); delivery-mutation tracking.

### `routes/` & `route-optimization/`

- **routes controller** `routes` (+ `route-runs`) — customer-assignments, live, route get/patch/delete, stops add/reorder/remove; runs: `my-runs`, `my-stats` (declared before `:id`), get, stop complete / complete-with-payment, stop patch, run patch/status/delete.
- **service** — `findAll`, `findOne`, `create`, `updateRoute`, `addStop`, `reorderStops`, `deleteStop`, `createRun` (passes `podPhotoUrls: []`), `completeStop(runId,stopId,mutations,podPhotos)`, `completeWithPayment`, `updateRunStop`, `getMyRuns`, `getMyStats`, `updateRunStatus`.
- **route-optimization controller** `route-optimization` — `:id/optimize`, `:id/analyze` (external optimizer suggests stop order).
- side effects: Route/RouteStop/RouteCustomer/RouteRun/RouteRunStop/DeliveryMutation writes; Socket.io broadcast; payment recording; inventory adjust on mutations.

### `invoices/`

- **controller** `invoices` — from-order(+/partial), payments (export/record/get/list), per-id: get/patch, send, send-email, send-reminder, void, revert-to-draft, unvoid, reopen, duplicate, pdf, write-off, payments CRUD, price-adjustment, delete.
- **service** — `findAll`, `findOne`, `createFromOrder`, `update`, `send`, `sendEmail`, `sendReminder`, `void`, `revertToDraft`, `unvoid`, `reopen`, `duplicate`, `generatePDF`, `recordPayment`, `voidPayment`, `priceAdjustment`, `writeOff`. **`buildInvoiceItemData`** prorates boxed lines and carries an order line's override as net `unitPrice` + `originalPrice` (strikethrough) with **`discount: 0`** — it must NOT re-derive a discount from `originalPrice` or the override double-counts (every consumer bills `computeLineSubtotal(unitPrice) − discount`); **`recomputeOrderFromInvoices(orderId)`** = backward sync (rebuilds the linked order's items+totals from the SUM of all non-void invoices), called from `update`/`priceAdjustment` when `orderId` set (inverse of `reconcileOrderDraftInvoice`). side effects: Invoice/InvoiceItem/InvoicePayment + linked Order writes; Transaction ledger; email; PDF; journal entries.

### `credit-notes/`

- **controller** `credit-notes` — create, list, get, issue, apply, void.
- **service** — `create`, `findAll`, `findOne`, `issue`, `apply`, `void`. side effects: CreditNote writes; ledger entries; optional auto-apply to invoices.

### `returns/`

- **controller** `returns` — `@Get/:id`, approve, reject, in-transit, receive, refund, cancel.
- **service** — `findAll`/`findAllForUser(userId,role)` (CUSTOMER filtered), `findOne`, `create`, `approve`, `reject`, `markInTransit`, `receive`, `refund`, `cancel`. side effects: Return/ReturnItem writes; inventory PURCHASE on receive; credit-note auto-gen on refund; email.

### `order-templates/`

- **controller** `order-templates` — get/patch/delete, items add/remove, `:id/generate`.
- **service** — `findAll`, `findOne`, `update`, `delete`, `addItem`, `removeItem`, `generateOrder` (draft Order from template). side effects: OrderTemplate(+Item)/Order writes.

### `inventory/`

- **controller** `inventory` — overview, movements (+purchase/adjustment), stock-count/commit, suppliers CRUD, purchase-orders CRUD + send/receive/close, forecasting.
- **service** — `getOverview`, `getMovements`, `recordPurchaseMovement`, `recordAdjustment`, `commitStockCount`, PO CRUD + `sendPO`/`receivePO`/`closePO`, `getForecasting`. side effects: StockLot/StockMovement/PurchaseOrder(+Item) writes; ledger.

### `billing/`

- **controller** `billing` (+ `billing/webhook`) — tenant billing get, checkout, portal, ensure-customer; Stripe webhook.
- **service** — `initializeCheckout`, `createCustomerPortal`, `ensureStripeCustomer`, `handleWebhook`. side effects: TenantSubscription/Invoice writes on payment; Stripe API; guard cache invalidation.

### `estimates/`

- **controller** `estimates` — create, list, get, send, accept, decline, convert-to-invoice, void.
- **service** — `create`, `findAll`, `findOne`, `send`, `accept`, `decline`, `convertToInvoice`, `void`. side effects: Estimate(+Item) writes; Invoice on convert; email.

### `vendor-bills/`

- **controller** `vendor-bills` — create, list, scan-invoice, product-mappings CRUD, per-id get/patch/receive/revert-to-draft/void/payments/delete, bulk delete.
- **service** — `create`, `findAll`, `findOne`, `update`, `receive`, `recordPayment`, `revertToDraft`, `void`, `delete`, `scanInvoice` (OCR), product-mapping CRUD. side effects: VendorBill(+Item)/BillPayment writes; inventory PURCHASE on receive; expense entries.

### `recurring-invoices/`

- **controller** `recurring-invoices` — CRUD + `:id/run`.
- **service** — `create`, `findAll`, `findOne`, `update`, `delete`, `run`, `runScheduled` (cron). side effects: RecurringInvoice(+Item)/Invoice writes on run.

### `bookkeeping/`

- **controller** `bookkeeping` — summary, dashboard, transactions (+/:id, payments, pdf), expense-categories CRUD, mileage-rates CRUD, expenses (+bulk, batch-status).
- **service** — `getSummary`, `getDashboard`, `getTransactions`, `getTransaction`, `recordPayment`, `recordExpense`/`recordBulkExpenses`, expense-category + mileage-rate CRUD. side effects: Transaction(+Item)/Expense/ExpenseCategory/MileageRate writes; PDF.

### `analytics/`

- **controller** `analytics` — overview, revenue, top products/customers, route/driver performance, inventory turnover/dead-stock/margin-alerts, dso, sales-by-category, gross-margin, aov, price/cost history.
- **service** — corresponding read aggregates. side effects: read-only (caching recommended).

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
