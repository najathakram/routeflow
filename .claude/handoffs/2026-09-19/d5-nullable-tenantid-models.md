# D5 — nullable `tenantId` models (origin/master @ 91d323de)

125 models carry `tenantId`: **81 nullable**, **44 NOT NULL** (count only).

## Mechanism found (governs every verdict below)

- `PrismaService.forTenant()`/`.tenantTransaction()` (`apps/api/src/prisma/prisma.service.ts`)
  auto-inject `tenantId` into TOP-LEVEL `create`/`createMany`/`upsert` from request context — via
  `this.prisma.forTenant().model.create()`, a `const db = this.prisma.forTenant()`/`tx ??
  this.prisma.forTenant()` local, or a `tx` threaded through a helper that traces to
  `tenantTransaction()`.
- **Documented footgun**: the extension can't see NESTED relation writes (`parent.create({data:
  {items:{create:[...]}}})`) — root cause of 3 prod incidents (`apps/api/scripts/backfill-
  invoiceitem-tenantid.mjs`, `-payment-movement-tenantid.mjs`, `-routerun-tenantid.ts`) + one
  in-schema warning (`StockCountLine`). Fix, tagged `// nested creates bypass forTenant()
  extension`, inlines `tenantId: this.prisma.getTenantId()` into the nested literal — confirmed at
  Invoice/Item, RecurringInvoice/Item, OrderTemplate/Item, Estimate/Item, Order's line builder,
  Return/Item, trips.service.ts.
- **CONFIRMED live gap**: `PurchaseOrderItem` — `inventory.service.ts:1041-1065` builds
  `itemsData` with no `tenantId`, nested under `purchaseOrder.create()`. No fix applied here,
  unlike the siblings above. Matches the historical census (3/3 rows NULL).
- Prior census `project_null_tenant_rows_2026-09-05.md`: 16 tables had NULLs (12,357 rows), all now
  zero (2026-09-19) — this audit is about the CODE path forward, not today's data.

## All 81 nullable models (T=tenant-owned, C=child/derivable, P=platform/global; all indexed on
tenantId except `AiUsageEvent`)

| Model | Domain | Cat | Writer verdict |
|---|---|---|---|
| User | tny | P/T | mixed: tenant via forTenant()/literal; SUPER_ADMIN null OK |
| UserPreference | tny | C | not found |
| DeviceToken | tny | C | not found |
| RefreshToken | tny | C | census: 100% NULL, structural |
| Product | cat | T | OK |
| Supplier | cat | T | OK |
| StockLot | cat | C | OK (direct tx create); hist. drift resolved |
| StockMovement | cat | C | OK (direct tx create); hist. drift resolved |
| PurchaseOrder | cat | T | OK |
| PurchaseOrderItem | cat | C | **GAP** — nested create, no tenantId (inventory.service.ts:1041) |
| ProductMapping | cat | T | OK |
| StockAlert | cat | T | not found |
| StockCountSession | cat | T | OK |
| StockCountLine | cat | C | OK — schema forbids nesting, confirmed |
| Customer | sal | T | OK |
| CustomerDocument | sal | C | OK |
| CustomerAddress | sal | C | OK |
| Driver | sal | T | OK |
| DriverLocation | sal | C | OK |
| Route | sal | T | OK |
| RouteStop | sal | C | OK |
| RouteCustomer | sal | C | not found |
| RouteRun | sal | C | OK; hist. orphan, backfilled |
| RouteRunStop | sal | C | OK; hist. orphan, backfilled |
| Order | sal | T | OK |
| OrderRevision | sal | C | OK |
| ChangeRequest | sal | C | OK |
| OrderItem | sal | C | OK |
| DeliveryMutation | sal | C | OK |
| DeliveryBatch | sal | C | not found |
| OrderTemplate | sal | T | OK |
| OrderTemplateItem | sal | C | OK — nested-create fix applied |
| ContactPerson | sal | C | OK |
| CustomerTag | sal | T | OK |
| CustomerTagAssignment | sal | C | not found |
| CustomerComment | sal | C | OK |
| Return | sal | T | OK |
| ReturnItem | sal | C | OK — nested-create fix applied |
| CustomerPrice | sal | T | not found |
| ReplenishmentSnooze | sal | T | not found |
| SalesAgent | sal | T | OK |
| SalesAgentRate | sal | C | OK |
| CustomerCommissionRate | sal | C | OK |
| AgentAssignment | sal | C | OK |
| CommissionAccrual | sal | C | `db: any` — comment says only "usually" caller's tx |
| CommissionAdjustment | sal | C | same hedge as CommissionAccrual |
| CommissionStatement | sal | T | OK |
| CommissionStatementLine | sal | C | OK |
| CommissionPayout | sal | C | OK |
| Transaction | fin | T | not found (unused?) |
| TransactionItem | fin | C | not found |
| Payment | fin | T | not found (unused?) |
| Invoice | fin | T | OK — nested-item fix applied |
| InvoiceItem | fin | C | OK — nested fix (3 sites) |
| InvoicePayment | fin | C | OK; hist. drift, backfilled |
| PaymentCounter | fin | P | census: "singleton" refused by design forever |
| ExpenseCategory | fin | P/T | mixed: global defaults null, + tenant customs |
| Expense | fin | T | OK; hist. orphan deleted (unclassifiable) |
| ExpenseLineItem | fin | C | OK |
| MileageRate | fin | T | OK |
| CreditNote | fin | T | OK (both create() paths) |
| OrderCreditNote | fin | C | OK |
| Estimate | fin | T | OK |
| EstimateItem | fin | C | OK — nested-create fix applied |
| VendorBill | fin | T | OK |
| InvoiceScan | fin | T | OK |
| SupplierStatementScan | fin | T | OK |
| VendorBillItem | fin | C | census: 100% NULL (2043/2043), structural by design |
| BillPayment | fin | C | OK |
| AdvancePayment | fin | C | OK |
| SupplierCredit | fin | C | OK |
| RecurringInvoice | fin | T | hist. orphan (deleted); writer unverified |
| RecurringInvoiceItem | fin | C | hist. orphan (deleted); fix seen, unverified |
| Message | plt | C | OK (`db = forTenant()` local) |
| MessageThread | plt | T | OK |
| MessageTemplate | plt | T | OK |
| NotificationRule | plt | T | OK |
| MessageOptOut | plt | T | not found |
| InboundTriage | plt | T | not found |
| AuditLog | plt | P/T | mixed: platform-admin null by design (8275/25370) |
| AiUsageEvent | plt | T | not found; no idx |

## Non-nullable tenantId models: **44** (count only, per scope)

## Proposed split

### SET NOT NULL now — 56 models
Product, Supplier, PurchaseOrder, ProductMapping, StockCountSession, StockCountLine, StockLot,
StockMovement, Customer, CustomerDocument, CustomerAddress, Driver, DriverLocation, Route,
RouteStop, RouteRun, RouteRunStop, Order, OrderRevision, ChangeRequest, OrderItem,
DeliveryMutation, OrderTemplate, OrderTemplateItem, ContactPerson, CustomerTag, CustomerComment,
Return, ReturnItem, SalesAgent, SalesAgentRate, CustomerCommissionRate, AgentAssignment,
CommissionStatement, CommissionStatementLine, CommissionPayout, Invoice, InvoiceItem,
InvoicePayment, Expense, ExpenseLineItem, MileageRate, CreditNote, OrderCreditNote, Estimate,
EstimateItem, VendorBill, InvoiceScan, SupplierStatementScan, BillPayment, AdvancePayment,
SupplierCredit, Message, MessageThread, MessageTemplate, NotificationRule.
**Evidence:** every writer resolves — directly or via a threaded `tx`/`db` local — to
`forTenant()`/`tenantTransaction()`, or carries the repo's own `getTenantId()` nested-item fix;
spot-verified across inventory/customers/orders/routes/invoices/vendor-bills/messaging.

### Needs a backfill first — 19 models
UserPreference, DeviceToken, PurchaseOrderItem, StockAlert, RouteCustomer, DeliveryBatch,
CustomerTagAssignment, CustomerPrice, ReplenishmentSnooze, CommissionAccrual, CommissionAdjustment,
Transaction, TransactionItem, Payment, RecurringInvoice, RecurringInvoiceItem, MessageOptOut,
InboundTriage, AiUsageEvent.
**Evidence:** PurchaseOrderItem has a confirmed, live nested-create gap (see Mechanism);
CommissionAccrual/Adjustment's `db: any` is only "usually" the caller's tx per its own comment; the
rest had **zero** `.model.create(`/`createMany(` hits in `apps/api/src` — dead models, or a path
this grep can't see — each needs its write path found and patched/confirmed first.

### Stays nullable by design — 6 models
User, RefreshToken, PaymentCounter, ExpenseCategory, VendorBillItem, AuditLog.
**Evidence:** the 2026-09-05 census classified these STRUCTURAL: User (SUPER_ADMIN tenant-less by
design), RefreshToken (100% NULL, session rows), VendorBillItem (100% NULL/2043, read only via its
parent, never populated on purpose), PaymentCounter (the `"singleton"` row predates multi-tenancy),
ExpenseCategory (global defaults are intentionally tenant-less, mixed with tenant customs),
AuditLog (platform-admin actions are legitimately tenant-less — 8275/25370).
