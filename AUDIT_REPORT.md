# RouteFlow — Comprehensive System Audit Report

**Date**: 2026-03-30
**Auditor**: Claude (Senior Full-Stack Systems Architect & ERP Domain Expert)
**Scope**: Complete codebase audit — API, Web, Mobile, Database, Architecture

---

## 1. Executive Summary

### What Works Well
RouteFlow is a **remarkably complete** wholesale distribution ERP built on a modern stack (NestJS + Next.js + React Native + PostgreSQL). It covers the full order-to-cash cycle, has real-time WebSocket communication, multi-role access (Operator/Driver/Customer), and a comprehensive set of 263+ API endpoints across 30 modules with 44 database models. The mobile app supports both driver and customer workflows including barcode scanning, GPS-tracked deliveries, and proof-of-delivery capture.

### What's Broken or At Risk

1. **Dual Financial Record System** — Every delivered order creates BOTH a `Transaction` (bookkeeping) AND an `Invoice` (billing). These are independent models with separate payment recording, creating reconciliation nightmares. Payments recorded on one don't update the other.

2. **Race Conditions in State Transitions** — `changeStatus()` for orders and `send()`/`void()`/`reopen()` for invoices are NOT wrapped in database transactions. Concurrent requests can corrupt state.

3. **Order State Machine Allows Dangerous Reversals** — DELIVERED orders can revert to CONFIRMED, potentially triggering duplicate invoices or financial inconsistencies since the invoice and transaction were already created.

4. **Route Runs Can Get Stuck** — If any stop remains PENDING or IN_PROGRESS, the route run stays IN_PROGRESS indefinitely with no force-complete or cancel mechanism.

5. **No Credit Limit Enforcement** — The Customer model has no `creditLimit` field. Orders can be placed without any credit exposure validation.

### Top 5 Priorities (Immediate Action Required)
1. **Deprecate Transaction model** — Consolidate all financial operations on Invoice/InvoicePayment (partially done in this session's report fixes)
2. **Wrap state transitions in transactions** — Orders, invoices, returns
3. **Make DELIVERED a terminal state** — Remove DELIVERED→CONFIRMED transition
4. **Add force-complete/cancel to route runs** — Prevent stuck runs
5. **Add credit limit field + enforcement** — Block orders exceeding credit exposure

---

## 2. System Map

### Tech Stack
| Layer | Technology | Version |
|-------|-----------|---------|
| API Framework | NestJS | 11 |
| Database | PostgreSQL | 16 |
| ORM | Prisma | 7.4 |
| Web Frontend | Next.js (App Router) | 14.2 |
| Mobile | Expo + React Native | 55 / 0.83 |
| State Management | TanStack Query + Zustand | |
| Real-time | Socket.IO + Redis Adapter | 4.8 |
| Job Queue | Bull + Redis | |
| Auth | Passport.js (JWT + Local) | |
| Storage | Cloudflare R2 (S3-compatible) | |
| AI | Anthropic Claude SDK | |
| Maps | Google Maps API + OpenRouteService | |
| Push Notifications | Firebase Cloud Messaging | |

### Architecture
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Web (Next)  │  │ Mobile Expo │  │  Mobile Expo │
│  Operator UI │  │  Driver App │  │ Customer App │
└──────┬───────┘  └──────┬──────┘  └──────┬───────┘
       │                 │                 │
       └────────────┬────┴────────────────┘
                    │ REST + WebSocket
              ┌─────┴──────┐
              │  NestJS API │──── Redis (Queue + WS)
              └─────┬──────┘
                    │ Prisma ORM
              ┌─────┴──────┐
              │ PostgreSQL  │
              └────────────┘
```

### Model Count by Domain
| Domain | Models | Key Models |
|--------|--------|-----------|
| Auth & Users | 4 | User, Customer, Driver, DeviceToken |
| Orders | 4 | Order, OrderItem, OrderTemplate, OrderTemplateItem |
| Routing | 5 | Route, RouteStop, RouteRun, RouteRunStop, RouteCustomer |
| Delivery | 1 | DeliveryMutation |
| Invoicing | 5 | Invoice, InvoiceItem, InvoicePayment, RecurringInvoice, RecurringInvoiceItem |
| Legacy Finance | 3 | Transaction, TransactionItem, Payment |
| Expenses | 2 | Expense, ExpenseCategory |
| Inventory | 3 | Product, StockMovement, StockLot |
| Purchasing | 4 | PurchaseOrder, PurchaseOrderItem, VendorBill, VendorBillItem, BillPayment |
| Returns | 2 | Return, ReturnItem |
| Estimates | 2 | Estimate, EstimateItem |
| Other | 5 | CreditNote, AdvancePayment, Supplier, CustomerPrice, SystemConfig, Message |

---

## 3. Feature Inventory Table

### Operator Features
| Feature | Status | API | Web | Tests |
|---------|--------|-----|-----|-------|
| Dashboard (KPIs, charts) | ✅ Functional | `/bookkeeping/summary`, `/finance-dashboard` | ✅ | ❌ |
| Customer CRUD | ✅ Functional | `/customers` | ✅ | ✅ spec |
| Customer Geocoding | ✅ Functional | `/customers/geocode-all` | ✅ | ❌ |
| Customer Pricing | ✅ Functional | `/customers/:id/prices` | ✅ | ❌ |
| Customer Statements | ✅ Functional | `/customers/:id/statement` | ✅ | ❌ |
| Advance Payments | ✅ Functional | `/customers/:id/advance-payments` | ✅ | ❌ |
| Product Catalog | ✅ Functional | `/products` | ✅ | ✅ spec |
| Barcode Scanning | ✅ Functional | `/products/barcode/:barcode` | ✅ | ❌ |
| Product Images | ✅ Functional | `/products/:id/images` | ✅ | ❌ |
| Order Management | ✅ Functional | `/orders` | ✅ | ✅ spec |
| Order Status Changes | ⚠️ Race condition | `/orders/:id/status` | ✅ | ❌ |
| Driver Management | ✅ Functional | `/drivers` | ✅ | ✅ spec |
| Route Creation | ✅ Functional | `/routes` | ✅ (map) | ✅ spec |
| Route Optimization | ✅ Functional | `/routes/:id/optimize` | ✅ | ❌ |
| Route Run Dispatch | ✅ Functional | `/route-runs` | ✅ | ❌ |
| Packing Lists | ✅ Functional | `/routes/:id/packing-list` | ✅ | ❌ |
| Invoice CRUD | ✅ Functional | `/invoices` | ✅ | ❌ |
| Invoice Auto-gen from Order | ✅ Functional | Auto in `completeStop()` | ✅ | ✅ QA |
| Invoice PDF | ✅ Functional | `/invoices/:id/pdf` | ✅ | ❌ |
| Invoice Payments | ✅ Functional | `/invoices/:id/payments` | ✅ | ✅ QA |
| Recurring Invoices | ✅ Functional | `/recurring-invoices` | ✅ | ❌ |
| Credit Notes | ✅ Functional | `/credit-notes` | ✅ | ❌ |
| Estimates | ✅ Functional | `/estimates` | ✅ | ❌ |
| Estimate → Invoice | ✅ Functional | `/estimates/:id/convert-to-invoice` | ✅ | ❌ |
| Returns Management | ✅ Functional | `/returns` | ✅ | ❌ |
| Inventory Overview | ✅ Functional | `/inventory/overview` | ✅ | ❌ |
| Stock Movements | ✅ Functional | `/inventory/movements` | ✅ | ❌ |
| FIFO/LIFO Costing | ✅ Functional | Embedded in service | N/A | ❌ |
| Purchase Orders | ✅ Functional | `/inventory/purchase-orders` | ✅ | ❌ |
| Vendor Bills | ✅ Functional | `/vendor-bills` | ✅ | ❌ |
| Vendor Bill Scanning (AI) | ✅ Functional | `/vendor-bills/scan-invoice` | ✅ | ❌ |
| Expense Tracking | ✅ Functional | `/bookkeeping/expenses` | ✅ | ✅ QA |
| Supplier Management | ✅ Functional | `/suppliers` | ✅ | ❌ |
| Financial Reports (16) | ✅ Functional | `/bookkeeping/reports/*` | ✅ | ✅ QA (70 tests) |
| Analytics (14 endpoints) | ✅ Functional | `/analytics/*` | ✅ | ❌ |
| CSV Import (6 types) | ✅ Functional | `/import/*` | ✅ | ❌ |
| System Settings | ✅ Functional | `/settings` | ✅ | ❌ |
| Standing Orders | ✅ Functional | `/order-templates` | ✅ | ❌ |
| Real-time Messaging | ✅ Functional | `/messages` + WebSocket | ✅ | ❌ |
| Push Notifications | ✅ Functional | `/notifications` | N/A | ❌ |

### Driver Features
| Feature | Status | Mobile |
|---------|--------|--------|
| Dashboard | ✅ | ✅ |
| Active Route View | ✅ | ✅ (map) |
| Stop Completion | ✅ | ✅ |
| Delivery Mutations | ✅ | ✅ |
| Proof of Delivery (photos) | ✅ | ✅ |
| New Order at Stop | ✅ | ✅ |
| Return Processing | ✅ | ✅ |
| Inventory at Hand | ✅ | ✅ |
| Stock Purchase/Adjust | ✅ | ✅ |
| Invoice Creation | ✅ | ✅ |
| Performance History | ✅ | ✅ |
| Messaging (to operator) | ✅ | ✅ |

### Customer Features
| Feature | Status | Mobile |
|---------|--------|--------|
| Product Browse/Shop | ✅ | ✅ |
| Order Placement | ✅ | ✅ |
| Order History | ✅ | ✅ |
| Order Tracking | ✅ | ✅ |
| Invoice Viewing | ✅ | ✅ |
| Account Statement | ✅ | ✅ |
| Standing Orders | ✅ | ✅ |
| Returns | ✅ | ✅ |
| Credit Notes | ✅ | ✅ |
| Profile Management | ✅ | ✅ |

---

## 4. Critical Issues

### 4.1 — Dual Financial Record System (CRITICAL)
**Files**: `orders.service.ts` lines 513-580, `bookkeeping.service.ts`, `invoices.service.ts`

When an order is delivered in `completeStop()`:
- **Line 513**: Upserts a `Transaction` record (totalOwed, status=UNPAID)
- **Line 551**: Creates an `Invoice` record (total, status=SENT)
- These are INDEPENDENT models with SEPARATE payment recording
- Recording payment on Invoice does NOT update Transaction (and vice versa)

**Business Impact**: Operator records payment in invoices screen → Invoice shows PAID. But Transaction still shows UNPAID in bookkeeping. Financial reports that query different models show different numbers.

**Fix**: Deprecate `Transaction`/`Payment` model entirely. All financial reporting already migrated to Invoice/InvoicePayment in this session. Remove Transaction creation from `completeStop()` and mark Transaction endpoints as deprecated.

**Effort**: Medium (8-12 hours)

---

### 4.2 — Race Conditions in State Transitions (CRITICAL)
**Files**: `orders.service.ts` lines 226-311, `invoices.service.ts` lines 337-376

`changeStatus()` reads order state, validates transition, then updates — NOT in a transaction. Two concurrent requests can both read the same state and attempt conflicting transitions.

**Fix**: Wrap in `$transaction` with SELECT FOR UPDATE (or use Prisma's optimistic locking with a version field):
```typescript
await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.findUniqueOrThrow({ where: { id } });
  // validate + update within same transaction
});
```

**Effort**: Low (2-3 hours)

---

### 4.3 — DELIVERED Orders Can Revert (HIGH)
**File**: `orders.service.ts` line 249

```typescript
DELIVERED: ["CONFIRMED"],  // allows going backwards
```

Once delivered, an Invoice and Transaction have been created, stock has been decremented, and PDF generation has been queued. Reverting to CONFIRMED creates:
- Orphaned Invoice (still SENT, linked to order that's no longer DELIVERED)
- Double stock decrement if re-delivered
- Duplicate Transaction upsert (uses orderId as unique key, so it updates rather than duplicates)

**Fix**: Remove `CONFIRMED` from DELIVERED's allowed transitions. If truly needed, require an explicit "void and re-process" workflow that cleans up financial records.

**Effort**: Low (1 hour)

---

### 4.4 — Route Runs Can Get Stuck IN_PROGRESS (HIGH)
**File**: `routes.service.ts` lines 601-604

Auto-completion requires ALL stops to be COMPLETED or SKIPPED. If a stop is IN_PROGRESS or PENDING with no matching orders, there's no way to force-complete the run.

**Fix**: Add a `POST /route-runs/:id/force-complete` endpoint that marks remaining stops as SKIPPED and completes the run. Only OPERATOR role should access this.

**Effort**: Low (2-3 hours)

---

### 4.5 — No Credit Limit Enforcement (HIGH)
**File**: `prisma/schema.prisma` (Customer model)

The Customer model has no `creditLimit` field. No validation exists in `orders.service.ts create()` to check if a customer's outstanding balance exceeds their credit allocation.

**Fix**:
1. Add `creditLimit Decimal? @db.Decimal(10, 2)` to Customer model
2. In `orders.service.ts create()`, query outstanding Invoice balance and reject if `outstanding + newOrderTotal > creditLimit`

**Effort**: Medium (4-6 hours)

---

### 4.6 — Customer Deletion FK Ordering Bugs (FIXED in this session)
**File**: `customers.service.ts` lines 680-767

Multiple FK ordering issues existed:
- ✅ Returns deleted before Orders (fixed)
- ✅ DeliveryMutations deleted before Orders (fixed this session)
- ✅ RouteRunStops deleted before RouteStops (fixed this session)
- ✅ Transaction child records (Payment, TransactionItem) deleted before Transaction (fixed this session)

---

## 5. Redundancy Report

### 5.1 — Code-Level Redundancy

| Redundancy | Location | Recommendation |
|------------|----------|----------------|
| **Invoice creation logic duplicated** | `orders.service.ts` lines 539-578 (inline) AND `invoices.service.ts` `createInvoiceFromOrder()` | The `createInvoiceFromOrder()` method is dead code — never called. Remove it OR refactor `completeStop()` to call it via tx client |
| **Payment recording duplicated** | `bookkeeping.service.ts` `recordPayment()` (Transaction) AND `invoices.service.ts` `recordPayment()` (Invoice) | Deprecate bookkeeping `recordPayment()` — consolidate on Invoice payments |
| **Invoice number generation duplicated** | `orders.service.ts` lines 539-546 AND `invoices.service.ts` `generateInvoiceNumber()` | Extract to shared utility; pass tx client |
| **Customer balance queries duplicated** | `customers.service.ts` getStatement AND `bookkeeping.service.ts` getCustomerBalanceSummary | Both query Invoice model for balances — share computation logic |

### 5.2 — Data-Level Redundancy

| Redundancy | Impact | Fix |
|------------|--------|-----|
| **Transaction + Invoice** created for every delivered order | Data drift, inconsistent reports | Deprecate Transaction model; it's legacy |
| **Order.total + Invoice.total** stored independently | Can drift if order modified after invoice created | Derive Invoice total from linked Order, or prevent Order modification after DELIVERED |
| **Product.currentStock** denormalized | Can drift from SUM(StockMovement.quantity) | Periodically reconcile; add audit endpoint |

### 5.3 — UX-Level Redundancy

| Issue | Impact | Fix |
|-------|--------|-----|
| `/bookkeeping` page redirects to `/finance/reports` | Confusing navigation, dead routes | Remove bookkeeping page entirely |
| `/invoices/payments` redirects to `/finance/payments` | Two URLs for same page | Remove redirect page |
| Finance Dashboard + Analytics both show sales/revenue | Operator confused which to trust | Differentiate: Finance = accounting truth, Analytics = operational trends |
| Operator must record payment on Invoice AND Transaction | Double work, data drift | Deprecate Transaction payment recording |

---

## 6. Missing Functionality

### Must Have (Critical for Wholesale Distribution)

| Feature | Complexity | Impact | Notes |
|---------|-----------|--------|-------|
| **Credit limit enforcement** | Medium | Prevents overselling to bad-pay customers | Add `creditLimit` to Customer, check on order create |
| **Audit trail** | Medium | Required for financial compliance | Add `createdBy`/`updatedBy` to financial models |
| **Bank reconciliation** | High | Essential for accurate accounting | Match InvoicePayments to bank statement imports |
| **Force-complete route runs** | Low | Prevents stuck operations | Add OPERATOR endpoint to force-complete/cancel |
| **Returns → Credit Note automation** | Low | Reduces manual work | Auto-create CN when Return is PROCESSED |
| **Period-end close** | Medium | Prevents retroactive edits | Lock financial records for closed periods |

### Should Have (Competitive Advantage)

| Feature | Complexity | Impact |
|---------|-----------|--------|
| **Customer-specific catalog** | Medium | Show only relevant products to each customer |
| **Backorder management** | Medium | Track partially fulfilled orders across multiple deliveries |
| **Lot/batch tracking** | Medium | StockLot exists but not exposed in UI or reports |
| **Multi-warehouse** | High | Currently single-location; add warehouse field to Product/StockMovement |
| **Report PDF/Excel export** | Medium | Reports exist but no export functionality |
| **Email notifications** | Medium | Only push notifications currently; no email system |
| **SMS/WhatsApp notifications** | Medium | Critical for non-tech-savvy customers |

### Nice to Have (Future Enhancement)

| Feature | Complexity | Impact |
|---------|-----------|--------|
| **Multi-currency support** | High | Currently single-currency |
| **General ledger / Chart of accounts** | High | Full double-entry bookkeeping |
| **Balance sheet** | High | Requires GL implementation |
| **Vehicle/fleet management** | Medium | Track capacity, maintenance |
| **Delivery time windows** | Medium | Customer has deliveryWindowStart/End but not enforced in routing |
| **Granular permissions** | High | Currently role-based only (3 roles); need permission-based |

---

## 7. AI Integration Roadmap

### Immediate Value (Data Available, Clear ROI)

| Opportunity | Data Available | Integration Point | Priority |
|-------------|---------------|-------------------|----------|
| **Smart Reorder Suggestions** | ✅ StockMovement history, order patterns | `/inventory/forecasting` (already exists) | HIGH |
| **Invoice OCR/Scanning** | ✅ Already implemented | `/vendor-bills/scan-invoice` (Claude SDK) | DONE ✅ |
| **Expense Auto-categorization** | ✅ Expense + Category data | Suggest category on expense creation | MEDIUM |
| **Order Anomaly Detection** | ✅ Order history per customer | Flag unusual quantities/products in order create | MEDIUM |
| **Cash Flow Prediction** | ✅ InvoicePayment history with timing | Predict collection dates based on customer payment behavior | MEDIUM |

### Future Enhancement (Needs More Data)

| Opportunity | Data Needed | Integration Point | Priority |
|-------------|------------|-------------------|----------|
| **Demand Forecasting** | 6+ months of order history | Dashboard KPI + auto-reorder | LOW (need data history) |
| **Route Optimization (ML)** | Delivery times, traffic patterns | Enhance existing ORS integration | LOW |
| **Customer Churn Prediction** | Order frequency trends | Dashboard alert + customer detail | LOW |
| **Natural Language Orders** | Product catalog + customer history | "Send the usual to Ahmad's" → auto-build order | MEDIUM |
| **Conversational Analytics** | All report data | In-app chat: "What's my best-selling product?" | LOW |

---

## 8. UX Improvement Plan

### Top 10 Most-Performed Actions (Optimization Assessment)

| # | Action | Current Clicks | Optimal | Fix |
|---|--------|---------------|---------|-----|
| 1 | Complete a delivery stop | 3 (navigate → select items → confirm) | 2 | Pre-fill all items as DELIVERED by default |
| 2 | Record a payment on invoice | 4 (find invoice → open → payment tab → record) | 2 | Add "Record Payment" from invoice list row action |
| 3 | Create an order | 4 (select customer → add items → review → submit) | 3 | Add "Reorder" button on past orders |
| 4 | Check customer balance | 3 (find customer → open → statement tab) | 1 | Show balance inline on customer list |
| 5 | View delivery route | 3 (routes → select route → dispatch) | 2 | Dashboard shortcut to today's active routes |
| 6 | Check stock level | 2 (inventory → find product) | 1 | Show stock on product list by default |
| 7 | Create invoice | 5 (invoices → new → select customer → add items → save) | AUTO | Already auto-generated on delivery ✅ |
| 8 | Process a return | 4 (returns → new → select order → add items) | 3 | Add "Return" button on order detail page |
| 9 | View reports | 2 (finance → reports → select report) | 2 | Already optimal |
| 10 | Send invoice | 2 (open invoice → click send) | 1 | Already auto-sent on delivery ✅ |

### Mobile-Specific Recommendations
- **Offline support**: `useNetworkSync.ts` hook exists but limited — expand to queue order creation, stock movements, and delivery completions for offline operation
- **Barcode scanning**: Already functional via `@zxing/library` — consider adding bulk scan mode for warehouse receiving
- **Haptic feedback**: `expo-haptics` imported but underutilized — add feedback on delivery completion, payment recording

### Notification System Design
| Event | In-App | Push | Email | SMS |
|-------|--------|------|-------|-----|
| New order placed | ✅ | ✅ | ❌ (missing) | ❌ |
| Order delivered | ✅ | ✅ | ❌ | ❌ |
| Invoice sent | ✅ | ❌ | ❌ (should send PDF) | ❌ |
| Payment overdue | ❌ | ❌ | ❌ (critical gap) | ❌ |
| Low stock alert | ✅ | ❌ | ❌ | ❌ |
| Return processed | ❌ | ❌ | ❌ | ❌ |

**Recommendation**: Add email service (SendGrid or AWS SES) for invoice delivery, overdue reminders, and account statements. SMS/WhatsApp for delivery ETA and payment reminders.

---

## 9. Architecture Recommendations

### 9.1 — API Design
- **Strength**: RESTful, well-structured, consistent URL patterns
- **Weakness**: Global `/api/v1` prefix is good, but no API versioning strategy for breaking changes
- **Fix**: Document API version policy; add `Accept-Version` header support for future versions

### 9.2 — Error Handling
- **Strength**: NestJS exception filters catch most errors
- **Weakness**: Many service methods throw generic `InternalServerErrorException` or let Prisma errors bubble up as 500s
- **Fix**: Add custom exception filter that maps Prisma errors (P2002 unique constraint, P2003 FK violation, P2025 not found) to proper HTTP status codes

### 9.3 — Database Schema
- **Strength**: Well-normalized, appropriate use of Decimal for financial fields
- **Weakness**: Only 9 of 120+ foreign keys have explicit cascade rules. Most default to RESTRICT, which causes 500 errors on deletion
- **Fix**: Add explicit cascade rules for parent-child relationships (Invoice→InvoiceItem, Order→OrderItem, etc.)

### 9.4 — Missing Indexes (Performance)
| Table | Recommended Composite Index | Benefit |
|-------|-----------------------------|---------|
| Order | `[customerId, status, createdAt]` | Dashboard queries |
| Invoice | `[customerId, status]` | Customer statements |
| RouteRun | `[status, scheduledDate]` | Dispatch queries |
| Expense | `[categoryId, date, deletedAt]` | Expense reports |
| StockMovement | `[productId, type, createdAt]` | Inventory audit |

### 9.5 — Hard-Coded Values to Externalize
| Value | Current Location | Fix |
|-------|-----------------|-----|
| Payment terms (30 days) | `orders.service.ts:549`, `invoices.service.ts:149` | Add to SystemConfig |
| Invoice prefix `INV-` | `orders.service.ts:540` | Add to SystemConfig |
| Return prefix `RET-` | `returns.service.ts:27` | Add to SystemConfig |
| Payment tolerance `0.001` | `invoices.service.ts:33` | Add to SystemConfig |
| Tax rate `0.1` | `configuration.ts:44` | ✅ Already configurable via TAX_RATE env var |

### 9.6 — Testing Strategy
| Test Type | Current | Recommended |
|-----------|---------|-------------|
| Unit Tests | 8 spec files (partial coverage) | Cover all services, especially financial calculations |
| Integration Tests | 1 E2E spec | Add API integration tests for each endpoint |
| Reports QA | ✅ 70 tests passing (reports-qa.js) | Expand to cover all edge cases |
| Load Tests | None | Add k6/Artillery tests for concurrent order processing |
| Financial Audit Tests | None | Add tests that verify: Invoice total = SUM(items), Payment total ≤ Invoice total |

---

## 10. Recommended Implementation Sequence

### Phase 1 — Critical Fixes (Week 1-2)
1. **Wrap state transitions in transactions** — `changeStatus()`, invoice `send()`/`void()`/`reopen()`
2. **Make DELIVERED terminal** — Remove backward transition
3. **Add force-complete to route runs** — Prevent stuck runs
4. **Remove Transaction creation from completeStop()** — Consolidate on Invoice model
5. **Add explicit cascade rules** to schema for parent-child relationships

### Phase 2 — Data Integrity (Week 3-4)
6. **Add credit limit to Customer** — field + enforcement in order creation
7. **Add audit fields** — `createdBy`/`updatedBy` to Invoice, Payment, Expense, StockMovement
8. **Add composite indexes** — Performance optimization for dashboard queries
9. **Fix Prisma error mapping** — Custom exception filter for proper HTTP status codes
10. **Externalize hard-coded values** — Payment terms, invoice prefix, etc. to SystemConfig

### Phase 3 — Feature Completion (Week 5-8)
11. **Auto-create Credit Note from Return** — Reduce manual work
12. **Email service integration** — Invoice delivery, overdue reminders
13. **Report PDF/Excel export** — Download reports as files
14. **Expand mobile offline support** — Queue operations for later sync
15. **Customer-specific catalog** — Filter products by customer relationship

### Phase 4 — Competitive Edge (Week 9-12)
16. **AI demand forecasting** — Predict order volumes by product/customer
17. **Smart reorder points** — AI-adjusted based on seasonality
18. **Delivery time window enforcement** — Optimize routes around customer windows
19. **Granular permissions** — Permission-based access control beyond 3 roles
20. **Multi-warehouse support** — Add warehouse dimension to inventory

---

## Appendix A — Complete Endpoint Inventory (263+ endpoints)

See agent research output for full endpoint listing with HTTP methods, paths, and role requirements.

## Appendix B — Complete Schema (44 models, 23 enums)

See agent research output for full field-level schema documentation.

## Appendix C — Reports QA Results

**70 tests passed, 0 failed** across 16 report categories:
1. Sales by Customer ✅
2. Sales by Item ✅
3. AR Aging (Invoices) ✅
4. Invoice Details ✅
5. Bad Debts ✅
6. Customer Balance ✅
7. Payments Received ✅
8. Time to Get Paid ✅
9. Expense Details ✅
10. Expenses by Category ✅
11. Profit & Loss ✅
12. Cash Flow ✅
13. Finance Dashboard ✅
14. Bookkeeping Summary ✅
15. Edge Cases (future dates, empty results) ✅
16. Deprecated Aging Delegation ✅
