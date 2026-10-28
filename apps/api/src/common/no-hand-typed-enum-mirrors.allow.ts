/**
 * The allow-list for no-hand-typed-enum-mirrors.spec.ts: every hand-typed mirror of a Prisma enum that already
 * existed at SA-1049 PR-1's head (e43db61f0), one row per (file, enum): `count` is the number of groups in that
 * file attributed to that enum. It is exact both ways and may only shrink (OP-7): a match with no row fails, a row
 * whose count differs fails, a row that no longer matches fails.
 *
 * WHY, closed: `subset` (a transition table, stepper, role or tender list or filter: the note says what it
 * selects), `derived` (a wire value set that only shares names), `old-native` (mobile screens that retire), or
 * `pending:B3`..`pending:B8` (not yet reviewed; the named batch of SA-1049 either imports the shared list or
 * re-files the row as subset/derived with its reason, and B8 asserts none is left). The note of a pending row
 * names the first group's shape as the scan found it; it is not a ruling.
 * Batches: B3 packages/types, B4 messaging, B5 web, B6 PriceType, B7 API-local, mobile stays old-native.
 */
export const WHY = [
  "subset",
  "derived",
  "old-native",
  "pending:B3",
  "pending:B4",
  "pending:B5",
  "pending:B6",
  "pending:B7",
  "pending:B8",
] as const;
export type Why = (typeof WHY)[number];
export interface AllowRow {
  file: string;
  enum: string;
  count: number;
  why: Why;
  note: string;
}

// file | enum | count | why | note
const TABLE = `
apps/api/src/analytics/analytics.service.ts | InvoiceStatus | 1 | pending:B7 | array {DRAFT,VOID,WRITTEN_OFF}
apps/api/src/auth/apple-oauth.service.ts | UserRole | 1 | pending:B7 | array {OPERATOR,DRIVER,TENANT_ADMIN}
apps/api/src/auth/google-oauth.service.ts | UserRole | 1 | pending:B7 | array {OPERATOR,DRIVER,TENANT_ADMIN}
apps/api/src/auth/permissions/staff-capabilities.ts | OperatorPermissionGroup | 1 | pending:B7 | union {PRICING,ORDERS,FINANCE}
apps/api/src/auth/permissions/staff-capabilities.ts | UserRole | 2 | pending:B7 | array+union {OPERATOR,TENANT_ADMIN,SUPER_ADMIN}
apps/api/src/authorizations/authorizations.service.ts | AuthorizationStatus | 1 | pending:B7 | union {NONE,PENDING_REVIEW,VERIFIED,EXPIRED,REJECTED}
apps/api/src/billing/auto-lock-gate.ts | TenantClass | 1 | pending:B7 | array {TEST,DEMO,INTERNAL}
apps/api/src/billing/billing-cron.service.ts | UserRole | 1 | pending:B7 | array {TENANT_ADMIN,OPERATOR,DRIVER}
apps/api/src/billing/billing.service.ts | TenantStatus | 1 | pending:B7 | union {ACTIVE,CANCELLED,SUSPENDED,READ_ONLY}
apps/api/src/billing/entitlements.service.ts | MeterKey | 1 | pending:B7 | object {SEATS,ROUTES,SCANS,MSGS,CUSTOMERS}
apps/api/src/billing/meter.service.ts | MeterKey | 2 | pending:B7 | array+chain {SEATS,ROUTES,SCANS,MSGS,CUSTOMERS}
apps/api/src/billing/meter.service.ts | UserRole | 1 | pending:B7 | array {TENANT_ADMIN,OPERATOR,DRIVER}
apps/api/src/billing/plan-catalog.constants.ts | MeterKey | 1 | pending:B7 | array {SEATS,ROUTES,SCANS,MSGS,CUSTOMERS}
apps/api/src/billing/plan-catalog.constants.ts | TenantPlan | 4 | pending:B7 | array+object+union {LITE,STARTER,GROWTH,SCALE,ENTERPRISE}
apps/api/src/billing/subscription-mutation.service.ts | UserRole | 1 | pending:B7 | array {TENANT_ADMIN,OPERATOR,DRIVER}
apps/api/src/bookkeeping/bookkeeping.controller.ts | ExpenseStatus | 1 | pending:B7 | union {PENDING,RECEIVED,PAID,VOID}
apps/api/src/bookkeeping/bookkeeping.service.ts | ExpenseStatus | 1 | pending:B7 | union {PENDING,RECEIVED,PAID,VOID}
apps/api/src/bookkeeping/dto/create-expense.dto.ts | ExpenseStatus | 2 | pending:B7 | array+union {PENDING,RECEIVED,PAID,VOID}
apps/api/src/buyer/buyer-admin.controller.ts | BuyerAccountStatus | 1 | pending:B7 | union {ACTIVE,SUSPENDED,DELETED}
apps/api/src/buyer/buyer-admin.service.ts | BuyerAccountStatus | 1 | pending:B7 | union {ACTIVE,SUSPENDED,DELETED}
apps/api/src/buyer/buyer-dashboard.service.ts | OrderStatus | 2 | pending:B7 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
apps/api/src/buyer/buyer.service.ts | CustomerLinkStatus | 1 | pending:B7 | array {ACTIVE,INVITED,PENDING_SELLER_APPROVAL}
apps/api/src/crm/gohighlevel/gohighlevel-poll.service.ts | CrmHandoffStatus | 4 | pending:B7 | array+object {CREATED,LINKED,SKIPPED,DRY_RUN,NEEDS_REVIEW,FA…
apps/api/src/documents/receipt-model.ts | PaymentMethod | 2 | pending:B7 | array+object {CASH,CARD,CHECK,OTHER,STORE_CREDIT}
apps/api/src/email/mailbox/mailbox-connection.service.ts | MailboxConnectionStatus | 2 | pending:B7 | union {CONNECTED,REVOKED,THROTTLED}
apps/api/src/import/batch-import.service.ts | ImportBatchStatus | 1 | pending:B7 | union {PROCESSING,READY,POSTED,PARTIALLY_POSTED}
apps/api/src/import/connectors/source-connectors.ts | MigrationSource | 1 | pending:B7 | object {CSV,PAPER,ZOHO,QUICKBOOKS}
apps/api/src/import/numbering.service.ts | DocumentNumberType | 3 | pending:B7 | array+chain+union {INVOICE,ESTIMATE,CREDIT_NOTE}
apps/api/src/inventory/dto/stock-count-session.dto.ts | StockCountStatus | 2 | pending:B7 | array+union {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/api/src/inventory/stock-count-commit.ts | StockCountStatus | 1 | pending:B7 | union {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/api/src/invoices/credit-exposure.ts | InvoiceStatus | 2 | pending:B7 | array {SENT,VIEWED,PARTIAL,OVERDUE}
apps/api/src/invoices/delivery-evidence.ts | MutationType | 1 | pending:B7 | array {DELIVERED,PARTIAL,SUBSTITUTED,REFUSED}
apps/api/src/invoices/dto/create-invoice.dto.ts | PaymentStatus | 1 | pending:B7 | array {DRAFT,PAID,VOID}
apps/api/src/invoices/invoice-line-override.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/api/src/invoices/invoice-send-guard.ts | InvoiceStatus | 1 | pending:B7 | array {SENT,VIEWED,PARTIAL,OVERDUE}
apps/api/src/invoices/payment-idempotency.ts | PaymentIdempotencyState | 1 | pending:B7 | union {CLAIMED,COMPLETED,TOMBSTONED}
apps/api/src/invoices/payment-ref-dedupe.ts | UserRole | 1 | pending:B7 | array {SUPER_ADMIN,TENANT_ADMIN,OPERATOR}
apps/api/src/messaging/staff-order-email.ts | NotificationEvent | 2 | pending:B4 | object+union {STAFF_NEW_ORDER,BUYER_ORDER_EDITED,BUYER_ORDER…
apps/api/src/onboarding/dto/onboarding.dto.ts | OnboardingCaseStatus | 2 | pending:B7 | array+union {OPEN,ON_HOLD,LOST}
apps/api/src/onboarding/onboarding-catalog.ts | OnboardingStage | 1 | pending:B7 | array {FOLLOW_UP,AGREE,ACTIVATE,COLLECT,CONFIGURE,VER…
apps/api/src/onboarding/onboarding-catalog.ts | OnboardingStepStatus | 1 | pending:B7 | union {PENDING,DONE,WAIVED}
apps/api/src/onboarding/onboarding-intake.service.ts | IntakeSectionKey | 1 | pending:B7 | array {ACCOUNT,TAX_COMPLIANCE,INVOICING,TEAM,OPERATIO…
apps/api/src/onboarding/onboarding-intake.service.ts | IntakeSectionStatus | 1 | pending:B7 | array {EMPTY,DRAFT,CHANGES_REQUESTED}
apps/api/src/onboarding/onboarding-intake.service.ts | OnboardingActorType | 1 | pending:B7 | union {ADMIN,CUSTOMER,SYSTEM}
apps/api/src/onboarding/onboarding-lifecycle.service.ts | IntakeSectionStatus | 1 | pending:B7 | array {EMPTY,DRAFT,CHANGES_REQUESTED}
apps/api/src/orders/backorder-marker.ts | OrderStatus | 1 | pending:B7 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
apps/api/src/orders/change-requests.service.ts | OrderStatus | 1 | pending:B7 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY}
apps/api/src/orders/counter-sale/counter-sale-payment.ts | PaymentMethod | 1 | pending:B7 | union {CASH,CREDIT_CARD,CHECK}
apps/api/src/orders/counter-sale/counter-sale-today.ts | PaymentMethod | 1 | pending:B7 | array {ADVANCE,CASH,CARD,CHECK,OTHER,STORE_CREDIT}
apps/api/src/orders/counter-sale/counter-tender-row.ts | PaymentMethod | 1 | pending:B7 | array {CASH,CREDIT_CARD,CHECK}
apps/api/src/orders/counter-sale/pickup-complete.service.ts | OrderStatus | 1 | pending:B7 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY}
apps/api/src/orders/line-author-channel.ts | OrderSource | 1 | pending:B7 | union {APP,PHONE,ROUTE}
apps/api/src/orders/order-status-transitions.ts | OrderStatus | 5 | pending:B7 | array+object {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTI…
apps/api/src/orders/orders.controller.ts | FulfillPath | 1 | pending:B7 | chain {SHIP,ROUTE,PICKUP}
apps/api/src/orders/orders.service.ts | InvoiceStatus | 1 | pending:B7 | array {PAID,PARTIAL,WRITTEN_OFF}
apps/api/src/orders/orders.service.ts | OrderStatus | 2 | pending:B7 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY}
apps/api/src/platform-admin/dto/activate-subscription.dto.ts | PaymentMethod | 1 | pending:B7 | array {ZELLE,BANK_TRANSFER,CHECK,CASH,WIRE,OTHER}
apps/api/src/policy/policy.service.ts | PolicyScopeType | 1 | pending:B7 | array {TENANT,CATEGORY,CUSTOMER}
apps/api/src/products/recipes.service.ts | RecipeStatus | 1 | pending:B7 | union {DRAFT,ACTIVE,RETIRED}
apps/api/src/regulated/dto/prepare-filing.dto.ts | ReportCadence | 2 | pending:B7 | array+union {MONTHLY,QUARTERLY,ANNUAL}
apps/api/src/regulated/period.ts | ReportCadence | 1 | pending:B7 | union {MONTHLY,QUARTERLY,ANNUAL}
apps/api/src/returns/dto/capture-inline-return.dto.ts | ReturnReason | 1 | pending:B7 | array {DAMAGED,WRONG_ITEM,CUSTOMER_REFUSED,QUALITY_IS…
apps/api/src/returns/inline-return-refund.ts | PaymentMethod | 1 | pending:B7 | array {CASH,CHECK,CREDIT_CARD,ACH,ZELLE,OTHER}
apps/api/src/returns/refund-tender.ts | PaymentMethod | 1 | pending:B7 | union {CASH,CREDIT_CARD,CHECK}
apps/api/src/returns/returns.service.ts | ReturnReason | 1 | pending:B7 | array {DAMAGED,WRONG_ITEM,CUSTOMER_REFUSED,QUALITY_IS…
apps/api/src/routes/routes.service.ts | PaymentMethod | 1 | pending:B7 | array {CASH,CHECK,CREDIT_CARD}
apps/api/src/sales-agents/commission-math.ts | CommissionRateSource | 1 | pending:B7 | union {ORDER_OVERRIDE,CUSTOMER_RATE,AGENT_DEFAULT,NON…
apps/api/src/sales-agents/commission-statements.service.ts | CommissionStatementLineKind | 1 | pending:B7 | union {CLAIM,ADJUSTMENT,CARRYFORWARD}
apps/api/src/selling-restrictions/selling-restrictions.core.ts | UserRole | 1 | pending:B7 | array {SUPER_ADMIN,TENANT_ADMIN,OPERATOR,DRIVER}
apps/api/src/settings-fulfilment/testing/fulfilment-world.ts | FulfillPath | 1 | pending:B7 | union {ROUTE,SHIP,PICKUP}
apps/api/src/supplier-statements/supplier-statements.service.ts | SupplierStatementScanStatus | 1 | pending:B7 | array {SCANNED,APPLIED,DISCARDED}
apps/api/src/tobacco/tobacco-report.service.ts | InvoiceStatus | 1 | pending:B7 | array {DRAFT,VOID,WRITTEN_OFF}
apps/api/src/tobacco/tobacco.service.ts | InvoiceStatus | 1 | pending:B7 | array {DRAFT,VOID,WRITTEN_OFF}
apps/api/src/trips/dto/create-trip.dto.ts | RouteOriginKind | 1 | pending:B7 | enum {TENANT,DRIVER,ADDRESS}
apps/api/src/trips/dto/route-planning.dto.ts | RouteEndKind | 1 | pending:B7 | enum {NONE,RETURN_TO_START,DRIVER_HOME,ADDRESS}
apps/api/src/vendor-bills/vendor-bills.service.ts | InvoiceScanStatus | 1 | pending:B7 | array {SCANNED,POSTED,DISCARDED,DUPLICATE}
apps/api/src/vendor-bills/vendor-bills.service.ts | VendorBillStatus | 2 | pending:B7 | chain {RECEIVED,PARTIAL,PAID}
apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx | OrderStatus | 1 | old-native | chain {DRAFT,PENDING,CONFIRMED}
apps/mobile/app/(operator)/payments/[id].tsx | CheckStatus | 1 | old-native | union {DEPOSITED,CLEARED,BOUNCED}
apps/mobile/app/(operator)/products/stock-counts.tsx | StockCountStatus | 1 | old-native | object {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/mobile/app/(operator)/vendor-bills/[id].tsx | PurchaseOrderStatus | 1 | old-native | chain {DRAFT,RECEIVED,PARTIAL}
apps/mobile/components/MapView.tsx | RouteRunStopStatus | 1 | old-native | union {PENDING,IN_PROGRESS,COMPLETED,SKIPPED}
apps/mobile/components/RegulatedCategoryForm.tsx | ReportCadence | 1 | old-native | array {MONTHLY,QUARTERLY,ANNUAL}
apps/mobile/lib/api/admin.ts | FulfillPath | 1 | old-native | union {ROUTE,SHIP,PICKUP}
apps/mobile/lib/api/customers.ts | DocumentNumberType | 1 | old-native | union {INVOICE,PAYMENT,CREDIT_NOTE,ADJUSTMENT}
apps/mobile/lib/api/expenses.ts | ExpenseStatus | 1 | old-native | union {PENDING,RECEIVED,PAID,VOID}
apps/mobile/lib/api/inventory.ts | MovementType | 1 | old-native | union {PURCHASE,SALE,ADJUSTMENT,RETURN,WRITE_OFF,COST…
apps/mobile/lib/api/invoices.ts | InvoiceStatus | 1 | old-native | union {DRAFT,SENT,VIEWED,PARTIAL,PAID,OVERDUE,VOID,WR…
apps/mobile/lib/api/orders.ts | FulfillPath | 2 | old-native | union {ROUTE,SHIP,PICKUP}
apps/mobile/lib/api/orders.ts | OrderStatus | 1 | old-native | union {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTI…
apps/mobile/lib/api/payments.ts | CheckStatus | 1 | old-native | union {RECORDED,DEPOSITED,CLEARED,BOUNCED}
apps/mobile/lib/api/payments.ts | PaymentStatus | 1 | old-native | union {DRAFT,PAID,VOID}
apps/mobile/lib/api/recurring-invoices.ts | RecurringFrequency | 1 | old-native | union {WEEKLY,BIWEEKLY,MONTHLY}
apps/mobile/lib/api/returns.ts | ReturnReason | 1 | old-native | union {DAMAGED,WRONG_ITEM,CUSTOMER_REFUSED,QUALITY_IS…
apps/mobile/lib/api/returns.ts | ReturnStatus | 1 | old-native | union {PENDING,APPROVED,REJECTED,IN_TRANSIT,RECEIVED,…
apps/mobile/lib/api/routes.ts | MutationType | 2 | old-native | union {DELIVERED,PARTIAL,REFUSED,ADD_ON}
apps/mobile/lib/api/routes.ts | RouteEndKind | 1 | old-native | union {NONE,RETURN_TO_START,DRIVER_HOME,ADDRESS}
apps/mobile/lib/api/routes.ts | RouteRunStatus | 1 | old-native | union {SCHEDULED,IN_PROGRESS,COMPLETED,CANCELLED}
apps/mobile/lib/api/routes.ts | RouteRunStopStatus | 1 | old-native | union {PENDING,IN_PROGRESS,COMPLETED,SKIPPED}
apps/mobile/lib/api/supplier-statements.ts | SupplierStatementScanStatus | 1 | old-native | union {SCANNED,APPLIED,DISCARDED}
apps/mobile/lib/api/tracked-categories.ts | InvoiceTreatment | 1 | old-native | union {SEPARATE_INVOICE,SEPARATE_SECTION,LINE_TAX}
apps/mobile/lib/api/tracked-categories.ts | ReportCadence | 1 | old-native | union {MONTHLY,QUARTERLY,ANNUAL}
apps/mobile/lib/api/tracked-categories.ts | TrackedCategoryTaxType | 1 | old-native | union {EXCISE_PER_UNIT,PERCENT_OF_SALE,PER_VOLUME,DEP…
apps/mobile/lib/api/vendor-bills.ts | InvoiceScanStatus | 1 | old-native | union {SCANNED,POSTED,DISCARDED,DUPLICATE}
apps/mobile/lib/auth.ts | UserRole | 1 | old-native | union {OPERATOR,TENANT_ADMIN,DRIVER,CUSTOMER,SUPER_AD…
apps/mobile/lib/auth.ts | UserStatus | 1 | old-native | union {ACTIVE,INACTIVE,SUSPENDED}
apps/mobile/lib/authorizations-logic.ts | AuthorizationStatus | 1 | old-native | union {NONE,PENDING_REVIEW,VERIFIED,EXPIRED,REJECTED}
apps/mobile/lib/buyer-licenses-logic.ts | AuthorizationStatus | 1 | old-native | union {NONE,PENDING_REVIEW,VERIFIED,EXPIRED,REJECTED}
apps/mobile/lib/check-badge.ts | CheckStatus | 1 | old-native | union {RECORDED,DEPOSITED,CLEARED,BOUNCED}
apps/mobile/lib/customer-authorizations-logic.ts | AuthorizationStatus | 1 | old-native | union {NONE,PENDING_REVIEW,VERIFIED,EXPIRED,REJECTED}
apps/mobile/lib/drafts-payload.ts | PriceType | 2 | old-native | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/mobile/lib/edit-items-draft.ts | ProductKind | 1 | old-native | union {FAMILY,STANDARD,VARIANT,RECIPE}
apps/mobile/lib/invoices-logic.ts | InvoiceStatus | 2 | old-native | chain {VOID,WRITTEN_OFF,PAID}
apps/mobile/lib/order-actions.ts | FulfillPath | 1 | old-native | union {ROUTE,SHIP,PICKUP}
apps/mobile/lib/order-draft-logic.ts | PriceType | 1 | old-native | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/mobile/lib/order-line-display.ts | ItemStatus | 1 | old-native | chain {CANCELLED,DELIVERED,PARTIAL}
apps/mobile/lib/order-line-display.ts | OrderStatus | 2 | old-native | array+object {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTI…
apps/mobile/lib/order-line-display.ts | PriceType | 1 | old-native | chain {DISCOUNTED,MANUAL,PROMO}
apps/mobile/lib/order-status-flow.ts | OrderStatus | 6 | old-native | array+object {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTI…
apps/mobile/lib/order-tracking-logic.ts | OrderStatus | 1 | old-native | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
apps/mobile/lib/payment-methods.ts | PaymentMethod | 2 | old-native | array+object {CASH,CHECK,ZELLE,ACH,CREDIT_CARD,OTHER}
apps/mobile/lib/pos-mode.ts | OrderStatus | 1 | old-native | chain {CONFIRMED,OUT_FOR_DELIVERY,DELIVERED}
apps/mobile/lib/regulated-format.ts | TrackedCategoryTaxType | 1 | old-native | case {EXCISE_PER_UNIT,PER_VOLUME,DEPOSIT_PER_CONTAIN…
apps/mobile/lib/returns-logic.ts | ReturnStatus | 2 | old-native | chain {PENDING,APPROVED,IN_TRANSIT,RECEIVED}
apps/mobile/lib/run-settlement.ts | PaymentMethod | 1 | old-native | array {CASH,CHECK,ZELLE,CREDIT_CARD,ADVANCE,OTHER}
apps/mobile/lib/shelf-logic.ts | OrderStatus | 1 | old-native | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY}
apps/mobile/lib/short-pick.ts | MutationType | 1 | old-native | union {DELIVERED,PARTIAL,REFUSED}
apps/mobile/lib/stock-count-logic.ts | StockCountStatus | 1 | old-native | union {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/mobile/lib/user-admin.ts | UserStatus | 1 | old-native | union {ACTIVE,INACTIVE,SUSPENDED}
apps/mobile/store/routeStore.ts | MutationType | 1 | old-native | union {UNRESOLVED,DELIVERED,PARTIAL,REFUSED}
apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx | TxnStatus | 1 | pending:B5 | union {UNPAID,PARTIAL,PAID}
apps/web/app/(dashboard)/customers/[id]/invoice-status-badge.tsx | InvoiceStatus | 2 | pending:B5 | object {SENT,VIEWED,PARTIAL,OVERDUE}
apps/web/app/(dashboard)/customers/[id]/page.tsx | CustomerLinkStatus | 1 | pending:B5 | chain {ACTIVE,INVITED,PENDING_SELLER_APPROVAL}
apps/web/app/(dashboard)/customers/_components/walk-in-protection.tsx | UserStatus | 1 | pending:B5 | array {ACTIVE,INACTIVE,SUSPENDED}
apps/web/app/(dashboard)/dashboard/page.tsx | OrderStatus | 2 | pending:B5 | object {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
apps/web/app/(dashboard)/dashboard/page.tsx | UserRole | 1 | pending:B5 | chain {OPERATOR,SUPER_ADMIN,TENANT_ADMIN}
apps/web/app/(dashboard)/dispatch/page.tsx | RouteRunStatus | 1 | pending:B5 | union {IN_PROGRESS,COMPLETED,CANCELLED,SCHEDULED}
apps/web/app/(dashboard)/estimates/page.tsx | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/app/(dashboard)/finance/commissions/[id]/page.tsx | CommissionAdjustmentKind | 1 | pending:B5 | object {CLAWBACK,RATE_CHANGE,REASSIGNMENT,MANUAL}
apps/web/app/(dashboard)/finance/commissions/[id]/page.tsx | CommissionStatementLineKind | 1 | pending:B5 | object {CLAIM,ADJUSTMENT,CARRYFORWARD}
apps/web/app/(dashboard)/finance/payments/[id]/page.tsx | PaymentStatus | 1 | pending:B5 | union {PAID,DRAFT,VOID}
apps/web/app/(dashboard)/finance/payments/page.tsx | PaymentStatus | 1 | pending:B5 | union {PAID,DRAFT,VOID}
apps/web/app/(dashboard)/finance/reports/page.tsx | EstimateStatus | 1 | pending:B5 | array {,DRAFT,SENT,ACCEPTED,DECLINED}
apps/web/app/(dashboard)/finance/reports/page.tsx | InvoiceStatus | 2 | pending:B5 | array+object {,DRAFT,SENT,PAID,OVERDUE,PARTIAL,VOID}
apps/web/app/(dashboard)/finance/reports/page.tsx | TxnStatus | 1 | pending:B5 | object {PAID,PARTIAL,UNPAID}
apps/web/app/(dashboard)/inventory/_components/PurchaseOrdersTab.tsx | PurchaseOrderStatus | 3 | pending:B5 | array+chain+object {DRAFT,SENT,PARTIAL,RECEIVED,CLOSED}
apps/web/app/(dashboard)/inventory/_components/purchase-orders-shared.ts | PurchaseOrderStatus | 1 | pending:B5 | union {DRAFT,SENT,PARTIAL,RECEIVED,CLOSED}
apps/web/app/(dashboard)/inventory/stock-counts/[id]/page.tsx | StockCountStatus | 1 | pending:B5 | object {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/web/app/(dashboard)/inventory/stock-counts/page.tsx | StockCountStatus | 1 | pending:B5 | object {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/web/app/(dashboard)/invoices/[id]/page.tsx | CheckStatus | 1 | pending:B5 | object {RECORDED,DEPOSITED,CLEARED,BOUNCED}
apps/web/app/(dashboard)/invoices/[id]/page.tsx | InvoiceStatus | 2 | pending:B5 | chain+object {SENT,VIEWED,PARTIAL,PAID,VOID,OVERDUE,WRITTEN_…
apps/web/app/(dashboard)/invoices/page.tsx | InvoiceStatus | 2 | pending:B5 | object {SENT,VIEWED,PARTIAL,OVERDUE}
apps/web/app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx | RecurringFrequency | 1 | pending:B5 | union {WEEKLY,BIWEEKLY,MONTHLY}
apps/web/app/(dashboard)/orders/[id]/_components/OrderLineItemCards.tsx | OrderStatus | 1 | pending:B5 | array {OUT_FOR_DELIVERY,PARTIALLY_DELIVERED,DELIVERED}
apps/web/app/(dashboard)/orders/[id]/_components/OrderLineItemsTable.tsx | PriceType | 1 | pending:B6 | chain {DISCOUNTED,MANUAL,PROMO}
apps/web/app/(dashboard)/orders/[id]/_components/PosOrderActions.tsx | OrderStatus | 1 | pending:B5 | chain {CONFIRMED,OUT_FOR_DELIVERY,DELIVERED}
apps/web/app/(dashboard)/orders/[id]/_components/line-status.ts | ItemStatus | 1 | pending:B5 | chain {CANCELLED,DELIVERED,PARTIAL}
apps/web/app/(dashboard)/orders/[id]/_components/order-line-edit.tsx | OrderStatus | 1 | pending:B5 | union {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,DELIV…
apps/web/app/(dashboard)/orders/[id]/_components/order-line-edit.tsx | PriceType | 1 | pending:B6 | chain {SPECIAL,DISCOUNTED,MANUAL}
apps/web/app/(dashboard)/orders/[id]/order-action-access.ts | UserRole | 1 | pending:B5 | array {OPERATOR,TENANT_ADMIN,SUPER_ADMIN}
apps/web/app/(dashboard)/orders/[id]/page.tsx | OrderStatus | 2 | pending:B5 | chain {DRAFT,PENDING,CONFIRMED}
apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/app/(dashboard)/purchase-orders/[id]/po-detail-logic.ts | PurchaseOrderStatus | 1 | pending:B5 | chain {SENT,PARTIAL,RECEIVED}
apps/web/app/(dashboard)/returns/[id]/page.tsx | ReturnReason | 1 | pending:B5 | object {DAMAGED,WRONG_ITEM,EXCESS_ORDER,CUSTOMER_REFUS…
apps/web/app/(dashboard)/returns/[id]/page.tsx | ReturnStatus | 4 | pending:B5 | array+object {PENDING,APPROVED,IN_TRANSIT,RECEIVED,REFUNDED,…
apps/web/app/(dashboard)/returns/page.tsx | ReturnReason | 1 | pending:B5 | object {DAMAGED,WRONG_ITEM,EXCESS_ORDER,CUSTOMER_REFUS…
apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx | RouteRunStatus | 1 | pending:B5 | union {SCHEDULED,IN_PROGRESS,COMPLETED,CANCELLED}
apps/web/app/(dashboard)/routes/my-runs/page.tsx | RouteRunStatus | 1 | pending:B5 | union {IN_PROGRESS,COMPLETED,CANCELLED,SCHEDULED}
apps/web/app/(dashboard)/routes/page.tsx | RouteRunStatus | 1 | pending:B5 | union {IN_PROGRESS,COMPLETED,CANCELLED,SCHEDULED}
apps/web/app/(dashboard)/sales-agents/[id]/page.tsx | CommissionAccrualStatus | 1 | pending:B5 | object {PENDING,PARTIAL,PAYABLE,SETTLED,VOID}
apps/web/app/(dashboard)/sales-agents/[id]/page.tsx | SalesAgentStatus | 2 | pending:B5 | array+object {ACTIVE,PAUSED,STOPPED_FOR_NEW}
apps/web/app/(dashboard)/sales-agents/page.tsx | SalesAgentStatus | 1 | pending:B5 | object {ACTIVE,PAUSED,STOPPED_FOR_NEW}
apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx | CrmConnectionStatus | 2 | pending:B5 | object+union {CONNECTED,NEEDS_ATTENTION,DISCONNECTED}
apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx | CrmHandoffStatus | 3 | pending:B5 | array+object {CREATED,LINKED,WRITEBACK_PENDING,DRY_RUN,NEEDS…
apps/web/app/(dashboard)/settings/_components/NotificationRulesCard.tsx | MessageChannel | 4 | pending:B4 | array+object {EMAIL,WHATSAPP,SMS,PORTAL}
apps/web/app/(dashboard)/settings/_components/NotificationRulesCard.tsx | NotificationEvent | 1 | pending:B4 | object {ORDER_CONFIRMED,OUT_FOR_DELIVERY,ORDER_SHIPPED…
apps/web/app/(dashboard)/settings/_components/NotificationRulesCard.tsx | WaApprovalStatus | 1 | pending:B5 | object {NONE,PENDING,APPROVED,REJECTED}
apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx | MessageChannel | 1 | pending:B4 | object {INTERNAL,WHATSAPP,SMS,EMAIL,PORTAL}
apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx | WaApprovalStatus | 1 | pending:B5 | object {NONE,PENDING,APPROVED,REJECTED}
apps/web/app/(dashboard)/settings/_components/StripeConnectCard.tsx | UserRole | 1 | pending:B5 | chain {OPERATOR,TENANT_ADMIN,SUPER_ADMIN}
apps/web/app/(dashboard)/settings/batch-import/page.tsx | ImportFileStatus | 2 | pending:B5 | object+union {QUEUED,PROCESSING,CLEAN,NEEDS_REVIEW,DUPLICATE…
apps/web/app/(dashboard)/settings/migration/page.tsx | MigrationJobStatus | 1 | pending:B5 | object {FETCHING,STAGED,CONFIRMED,UNDONE,FAILED}
apps/web/app/(platform-admin)/admin/buyers/[id]/page.tsx | BuyerAccountStatus | 2 | pending:B5 | union {ACTIVE,SUSPENDED,DELETED}
apps/web/app/(platform-admin)/admin/buyers/merge-requests/page.tsx | BuyerMergeRequestStatus | 1 | pending:B5 | object {PENDING_VERIFICATION,PENDING_REVIEW,COMPLETED,…
apps/web/app/(platform-admin)/admin/buyers/merge-requests/page.tsx | MergeInitiator | 1 | pending:B5 | object {BUYER,TENANT,SUPER_ADMIN}
apps/web/app/(platform-admin)/admin/buyers/page.tsx | BuyerAccountStatus | 2 | pending:B5 | union {ACTIVE,SUSPENDED,DELETED}
apps/web/app/buyer/portal/[seller]/dashboard/page.tsx | OrderStatus | 1 | pending:B5 | chain {PENDING,CONFIRMED,OUT_FOR_DELIVERY}
apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx | ChangeRequestType | 1 | pending:B5 | union {ADD_ITEM,CHANGE_QTY,REMOVE_ITEM,NOTE}
apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx | OrderStatus | 4 | pending:B5 | array+chain {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
apps/web/app/buyer/portal/[seller]/orders/page.tsx | OrderStatus | 1 | pending:B5 | case {PENDING,PROCESSING,IN_TRANSIT,CONFIRMED,OUT_FO…
apps/web/components/CategoryFormModal.tsx | ReportCadence | 2 | pending:B5 | array+object {MONTHLY,QUARTERLY,ANNUAL}
apps/web/components/CommandPalette.tsx | UserRole | 1 | pending:B5 | chain {OPERATOR,SUPER_ADMIN,TENANT_ADMIN}
apps/web/components/LineItemRow.tsx | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/components/OrderLineUnitPicker.tsx | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/components/RoutePlanningControls.tsx | RouteEndKind | 1 | pending:B5 | union {NONE,RETURN_TO_START,DRIVER_HOME,ADDRESS}
apps/web/components/RoutePlanningControls.tsx | RouteOriginKind | 1 | pending:B5 | union {TENANT,DRIVER,ADDRESS}
apps/web/components/line-price-tag.ts | PriceType | 1 | pending:B6 | chain {DISCOUNTED,MANUAL,PROMO}
apps/web/lib/api/authorizations.ts | AuthorizationStatus | 1 | pending:B5 | union {NONE,PENDING_REVIEW,VERIFIED,EXPIRED,REJECTED}
apps/web/lib/api/batch-import.ts | ImportBatchStatus | 1 | pending:B5 | union {PROCESSING,READY,POSTED,PARTIALLY_POSTED}
apps/web/lib/api/batch-import.ts | ImportFileStatus | 1 | pending:B5 | union {QUEUED,PROCESSING,CLEAN,NEEDS_REVIEW,DUPLICATE…
apps/web/lib/api/bookkeeping.ts | TxnStatus | 1 | pending:B5 | union {UNPAID,PARTIAL,PAID}
apps/web/lib/api/buyer-payments.ts | BuyerPaymentRequestStatus | 1 | pending:B5 | union {PENDING,SETTLING,SETTLED,APPROVED,REJECTED,FAI…
apps/web/lib/api/customers.ts | CustomerLinkStatus | 1 | pending:B5 | union {NOT_INVITED,INVITED,ACTIVE,PENDING_SELLER_APPR…
apps/web/lib/api/finance.ts | ExpenseStatus | 2 | pending:B5 | union {PENDING,RECEIVED,PAID,VOID}
apps/web/lib/api/invoices.ts | CheckStatus | 1 | pending:B5 | union {RECORDED,DEPOSITED,CLEARED,BOUNCED}
apps/web/lib/api/invoices.ts | FulfillPath | 1 | pending:B5 | union {ROUTE,SHIP,PICKUP}
apps/web/lib/api/invoices.ts | PaymentStatus | 3 | pending:B5 | union {DRAFT,PAID,VOID}
apps/web/lib/api/messaging.ts | MessageChannel | 1 | pending:B4 | union {INTERNAL,WHATSAPP,SMS,EMAIL,PORTAL}
apps/web/lib/api/messaging.ts | WaApprovalStatus | 1 | pending:B5 | union {NONE,PENDING,APPROVED,REJECTED}
apps/web/lib/api/migration.ts | MigrationJobStatus | 1 | pending:B5 | union {FETCHING,STAGED,CONFIRMED,UNDONE,FAILED}
apps/web/lib/api/migration.ts | MigrationSource | 1 | pending:B5 | union {ZOHO,QUICKBOOKS,CSV,PAPER}
apps/web/lib/api/numbering.ts | DocumentNumberType | 1 | pending:B5 | union {INVOICE,ESTIMATE,CREDIT_NOTE}
apps/web/lib/api/orders.ts | FulfillPath | 3 | pending:B5 | union {ROUTE,SHIP,PICKUP}
apps/web/lib/api/orders.ts | OrderStatus | 1 | pending:B5 | union {DRAFT,PENDING,CONFIRMED,OUT_FOR_DELIVERY,DELIV…
apps/web/lib/api/payment-requests.ts | BuyerPaymentRequestStatus | 1 | pending:B5 | union {PENDING,APPROVED,REJECTED,FAILED,EXPIRED,CANCE…
apps/web/lib/api/products.ts | CostingMethod | 1 | pending:B5 | union {FIFO,LIFO,AVCO,STANDARD,LAST_COST}
apps/web/lib/api/promotions.ts | PromotionScope | 1 | pending:B5 | union {ALL,CATEGORY,PRODUCTS}
apps/web/lib/api/promotions.ts | PromotionType | 1 | pending:B5 | union {PERCENT,FIXED,QTY_BREAK,BUY_N_GET_M}
apps/web/lib/api/returns.ts | ReturnReason | 1 | pending:B5 | union {DAMAGED,WRONG_ITEM,EXCESS_ORDER,CUSTOMER_REFUS…
apps/web/lib/api/returns.ts | ReturnStatus | 1 | pending:B5 | union {PENDING,APPROVED,REJECTED,IN_TRANSIT,RECEIVED,…
apps/web/lib/api/routes.ts | RouteEndKind | 2 | pending:B5 | union {NONE,RETURN_TO_START,DRIVER_HOME,ADDRESS}
apps/web/lib/api/routes.ts | RouteOriginKind | 1 | pending:B5 | union {TENANT,DRIVER,ADDRESS}
apps/web/lib/api/routes.ts | RouteRunStatus | 1 | pending:B5 | union {SCHEDULED,IN_PROGRESS,COMPLETED,CANCELLED}
apps/web/lib/api/routes.ts | RouteRunStopStatus | 2 | pending:B5 | union {PENDING,IN_PROGRESS,COMPLETED,SKIPPED}
apps/web/lib/api/sales-agents.ts | CommissionAccrualStatus | 1 | pending:B5 | union {PENDING,PARTIAL,PAYABLE,SETTLED,VOID}
apps/web/lib/api/sales-agents.ts | CommissionRateSource | 2 | pending:B5 | object+union {ORDER_OVERRIDE,CUSTOMER_RATE,AGENT_DEFAULT,NON…
apps/web/lib/api/sales-agents.ts | CommissionStatementLineKind | 1 | pending:B5 | union {CLAIM,ADJUSTMENT,CARRYFORWARD}
apps/web/lib/api/sales-agents.ts | CommissionStatementStatus | 1 | pending:B5 | union {PENDING,APPROVED,PAID,VOID}
apps/web/lib/api/sales-agents.ts | SalesAgentStatus | 1 | pending:B5 | union {ACTIVE,PAUSED,STOPPED_FOR_NEW}
apps/web/lib/api/stock-count.ts | StockCountStatus | 1 | pending:B5 | union {OPEN,REVIEW,COMMITTED,DISCARDED}
apps/web/lib/api/supplier-statements.ts | SupplierStatementScanStatus | 1 | pending:B5 | union {SCANNED,APPLIED,DISCARDED}
apps/web/lib/api/tracked-categories.ts | InvoiceTreatment | 1 | pending:B5 | union {SEPARATE_INVOICE,SEPARATE_SECTION,LINE_TAX}
apps/web/lib/api/tracked-categories.ts | ReportCadence | 1 | pending:B5 | union {MONTHLY,QUARTERLY,ANNUAL}
apps/web/lib/api/tracked-categories.ts | TrackedCategoryTaxType | 1 | pending:B5 | union {EXCISE_PER_UNIT,PERCENT_OF_SALE,PER_VOLUME,DEP…
apps/web/lib/api/users.ts | UserRole | 1 | pending:B5 | union {OPERATOR,DRIVER,CUSTOMER,TENANT_ADMIN}
apps/web/lib/api/users.ts | UserStatus | 2 | pending:B5 | union {ACTIVE,INACTIVE,SUSPENDED}
apps/web/lib/api/vendor-bills.ts | InvoiceScanStatus | 1 | pending:B5 | union {SCANNED,POSTED,DISCARDED,DUPLICATE}
apps/web/lib/auth.ts | UserRole | 1 | pending:B5 | union {OPERATOR,DRIVER,CUSTOMER,SUPER_ADMIN,TENANT_AD…
apps/web/lib/auth.ts | UserStatus | 1 | pending:B5 | union {ACTIVE,INACTIVE,SUSPENDED}
apps/web/lib/buyer-fulfilment.ts | OrderStatus | 1 | pending:B5 | object {OUT_FOR_DELIVERY,PARTIALLY_DELIVERED,DELIVERED}
apps/web/lib/buyer-invoice-status.ts | InvoiceStatus | 1 | pending:B5 | case {OVERDUE,VOID,WRITTEN_OFF}
apps/web/lib/buyer-order-again.ts | OrderStatus | 1 | pending:B5 | array {DELIVERED,PARTIALLY_DELIVERED,CANCELLED}
apps/web/lib/check-badge.ts | CheckStatus | 1 | pending:B5 | union {RECORDED,DEPOSITED,CLEARED,BOUNCED}
apps/web/lib/drafts.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/lib/fulfil-path-options.ts | FulfillPath | 2 | pending:B5 | object+union {ROUTE,SHIP,PICKUP}
apps/web/lib/handover-stamp.ts | UserRole | 1 | pending:B5 | array {OPERATOR,TENANT_ADMIN,SUPER_ADMIN}
apps/web/lib/invoice-draft-storage.ts | PriceType | 2 | pending:B6 | array+union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/lib/order-draft/resume.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/lib/order-line-unit.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
apps/web/lib/payment-methods.ts | PaymentMethod | 3 | pending:B5 | array+object {CASH,CHECK,ZELLE,ACH,CREDIT_CARD,OTHER}
apps/web/lib/reason-copy.ts | ReturnReason | 1 | pending:B5 | object {DAMAGED,WRONG_ITEM,CUSTOMER_REFUSED,QUALITY_IS…
apps/web/lib/regulated-format.ts | TrackedCategoryTaxType | 1 | pending:B5 | case {EXCISE_PER_UNIT,PER_VOLUME,DEPOSIT_PER_CONTAIN…
apps/web/lib/staff-price-override.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED,MANUAL}
packages/types/api/buyer.ts | AuthorizationStatus | 1 | pending:B3 | union {NONE,PENDING_REVIEW,EXPIRED,REJECTED}
packages/types/api/checks.ts | CheckStatus | 1 | pending:B3 | object {RECORDED,DEPOSITED,CLEARED,BOUNCED}
packages/types/api/counter-sale.ts | PaymentMethod | 1 | pending:B3 | array {ADVANCE,CASH,CARD,CHECK,OTHER,STORE_CREDIT}
packages/types/api/fulfilment-methods.ts | FulfillPath | 1 | pending:B3 | object {ROUTE,SHIP,PICKUP}
packages/types/api/fulfilment-methods.ts | OrderStatus | 3 | pending:B3 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY,DELIVERED}
packages/types/api/fulfilment.ts | FulfillPath | 1 | pending:B3 | union {ROUTE,SHIP,PICKUP}
packages/types/api/inline-returns.ts | ReturnStatus | 1 | pending:B3 | union {RECEIVED,REFUNDED,REJECTED,CANCELLED}
packages/types/api/messaging-matrix.ts | MessageChannel | 1 | pending:B3 | array {EMAIL,WHATSAPP,SMS,PORTAL}
packages/types/api/misc.ts | PriceType | 1 | pending:B6 | union {STANDARD,SPECIAL,DISCOUNTED}
packages/types/api/permissions.ts | OperatorPermissionGroup | 1 | pending:B3 | object {ORDERS,DISPATCH,CUSTOMERS,CATALOG,PRICING,REGU…
packages/types/api/permissions.ts | UserRole | 1 | pending:B3 | union {SUPER_ADMIN,TENANT_ADMIN,OPERATOR,DRIVER,CUSTO…
packages/types/api/products.ts | OrderStatus | 1 | pending:B3 | union {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
packages/types/api/ship-state.ts | OrderStatus | 1 | pending:B3 | array {OUT_FOR_DELIVERY,PARTIALLY_DELIVERED,DELIVERED}
packages/types/api/staff-capabilities.ts | OperatorPermissionGroup | 1 | pending:B3 | union {PRICING,ORDERS,FINANCE}
packages/types/api/staff-capabilities.ts | UserRole | 2 | pending:B3 | array+union {OPERATOR,TENANT_ADMIN,SUPER_ADMIN}
packages/types/api/stock-count.ts | StockCountStatus | 1 | pending:B3 | union {OPEN,REVIEW,COMMITTED,DISCARDED}
packages/types/index.ts | ItemStatus | 1 | pending:B3 | enum {PENDING,CONFIRMED,PARTIAL,DELIVERED,CANCELLED}
packages/types/index.ts | MutationType | 1 | pending:B3 | enum {DELIVERED,PARTIAL,REFUSED,ADD_ON,SUBSTITUTED}
packages/types/index.ts | OrderStatus | 1 | pending:B3 | enum {PENDING,CONFIRMED,OUT_FOR_DELIVERY,DELIVERED,C…
packages/types/index.ts | RouteRunStatus | 1 | pending:B3 | enum {SCHEDULED,IN_PROGRESS,COMPLETED,CANCELLED}
packages/types/index.ts | RouteRunStopStatus | 1 | pending:B3 | enum {PENDING,IN_PROGRESS,COMPLETED,SKIPPED}
packages/types/index.ts | TxnStatus | 1 | pending:B3 | enum {UNPAID,PARTIAL,PAID}
packages/types/index.ts | UserRole | 1 | pending:B3 | enum {OPERATOR,TENANT_ADMIN,CUSTOMER,DRIVER,SUPER_AD…
packages/types/index.ts | UserStatus | 1 | pending:B3 | enum {ACTIVE,INACTIVE,SUSPENDED}
packages/types/invoice-send-state.ts | InvoiceStatus | 1 | pending:B3 | array {SENT,VIEWED,OVERDUE,PARTIAL,PAID}
packages/types/order-line-backorder.ts | OrderStatus | 1 | pending:B3 | array {PENDING,CONFIRMED,OUT_FOR_DELIVERY,PARTIALLY_D…
packages/types/payment-ref-copy.ts | UserRole | 1 | pending:B3 | array {SUPER_ADMIN,TENANT_ADMIN,OPERATOR}
`;

export const ALLOWED: AllowRow[] = TABLE.trim()
  .split("\n")
  .map((line) => {
    const [file, enumName, count, why, ...note] = line.split(" | ");
    return { file, enum: enumName, count: Number(count), why: why as Why, note: note.join(" | ") };
  });
