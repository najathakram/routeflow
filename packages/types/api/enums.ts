// ─── Prisma-enum mirrors (wave E / imp-10b) ────────────────────────────────────
//
// One `const` array + derived type per Prisma enum that web and/or mobile
// hand-declare as a client-side string union. Values are copied EXACTLY from
// `apps/api/prisma/schema.prisma` — this file is the shared source for the
// pinned enums (see enum-parity.spec.ts for coverage — not every Prisma enum a
// client mirrors has a row here yet; see docs/IMPROVEMENTS.md item 10's
// follow-on), and `apps/api/src/common/enum-parity.spec.ts` pins every array
// here set-equal to the generated `@prisma/client` enum so a value can never
// silently drift again (a value invented, a value renamed, a value dropped).
//
// Convention: `export const X_VALUES = [...] as const;` +
// `export type X = (typeof X_VALUES)[number];` — never hand-write the union.

export const ESTIMATE_STATUS_VALUES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "CONVERTED",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUS_VALUES)[number];

export const EXPENSE_STATUS_VALUES = ["PENDING", "RECEIVED", "PAID", "VOID"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUS_VALUES)[number];

export const INVOICE_STATUS_VALUES = [
  "DRAFT",
  "SENT",
  "VIEWED",
  "PARTIAL",
  "PAID",
  "OVERDUE",
  "VOID",
  "WRITTEN_OFF",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS_VALUES)[number];

export const RETURN_STATUS_VALUES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "REFUNDED",
  "PROCESSED",
  "CANCELLED",
] as const;
export type ReturnStatus = (typeof RETURN_STATUS_VALUES)[number];

export const RETURN_REASON_VALUES = [
  "DAMAGED",
  "WRONG_ITEM",
  "CUSTOMER_REFUSED",
  "QUALITY_ISSUE",
  "EXCESS_ORDER",
] as const;
export type ReturnReason = (typeof RETURN_REASON_VALUES)[number];

// Returns Inside Order Creation (PR-1a, 2026-09-15). ReturnKind is a real Prisma enum
// (pinned below in ENUM_TABLE); RETURN_HOLD_REASON_VALUES/RETURN_PRICE_SOURCE_VALUES are
// plain-string columns (same CREATE-TYPE-avoidance reasoning as Return.refundMethod), so
// they are NOT in ENUM_TABLE — there is no generated Prisma enum to pin them against.
export const RETURN_KIND_VALUES = ["STANDARD", "INLINE"] as const;
export type ReturnKind = (typeof RETURN_KIND_VALUES)[number];

export const RETURN_HOLD_REASON_VALUES = [
  "CAPTURE_PENDING",
  "CAPTURE_FAILED",
  "OVER_RETURN",
  "DRIVER_CAP",
  "UNREFERENCED",
] as const;
export type ReturnHoldReason = (typeof RETURN_HOLD_REASON_VALUES)[number];

export const RETURN_PRICE_SOURCE_VALUES = [
  "SOURCE_INVOICE",
  "CUSTOMER_PRICE",
  "TIER",
  "BASE",
  "MANUAL",
] as const;
export type ReturnPriceSource = (typeof RETURN_PRICE_SOURCE_VALUES)[number];

export const CREDIT_NOTE_STATUS_VALUES = ["ISSUED", "APPLIED", "VOID"] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUS_VALUES)[number];

export const REGULATED_FILING_STATUS_VALUES = ["GENERATED", "FAILED"] as const;
export type RegulatedFilingStatus = (typeof REGULATED_FILING_STATUS_VALUES)[number];

export const INVOICE_TREATMENT_VALUES = [
  "SEPARATE_INVOICE",
  "SEPARATE_SECTION",
  "LINE_TAX",
] as const;
export type InvoiceTreatment = (typeof INVOICE_TREATMENT_VALUES)[number];

export const REPORT_CADENCE_VALUES = ["MONTHLY", "QUARTERLY", "ANNUAL"] as const;
export type ReportCadence = (typeof REPORT_CADENCE_VALUES)[number];

export const TRACKED_CATEGORY_TAX_TYPE_VALUES = [
  "EXCISE_PER_UNIT",
  "PERCENT_OF_SALE",
  "PER_VOLUME",
  "DEPOSIT_PER_CONTAINER",
  "NONE",
] as const;
export type TrackedCategoryTaxType = (typeof TRACKED_CATEGORY_TAX_TYPE_VALUES)[number];

export const INVOICE_SCAN_STATUS_VALUES = ["SCANNED", "POSTED", "DISCARDED", "DUPLICATE"] as const;
export type InvoiceScanStatus = (typeof INVOICE_SCAN_STATUS_VALUES)[number];

export const SUPPLIER_STATEMENT_SCAN_STATUS_VALUES = ["SCANNED", "APPLIED", "DISCARDED"] as const;
export type SupplierStatementScanStatus = (typeof SUPPLIER_STATEMENT_SCAN_STATUS_VALUES)[number];

/**
 * ⚠️ Drift fixed here (Wave E / imp-10b, L-072): mobile previously hand-typed
 * this union with a value `"FULL"` that has never existed in the schema, and
 * both apps omitted `OVERDUE`. This array is the corrected, pinned source —
 * see `enum-parity.spec.ts` for the regression guard and `.claude/lessons/LESSONS.md` L-072.
 */
export const VENDOR_BILL_STATUS_VALUES = [
  "DRAFT",
  "RECEIVED",
  "PARTIAL",
  "PAID",
  "OVERDUE",
  "VOID",
] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUS_VALUES)[number];

/**
 * ⚠️ Drift fixed here (Wave E / imp-10b, L-072): mobile previously hand-typed
 * this union (as `POStatus`) with `"PARTIALLY_RECEIVED"` where the schema says
 * `PARTIAL`. This array is the corrected, pinned source.
 */
export const PURCHASE_ORDER_STATUS_VALUES = [
  "DRAFT",
  "SENT",
  "PARTIAL",
  "RECEIVED",
  "CLOSED",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUS_VALUES)[number];

// PENDING added (post-dated check payments PR-1, additive-only): a CHECK payment recorded and
// held but not yet clearable/bankable. See finance.prisma's PaymentStatus doc comment.
export const PAYMENT_STATUS_VALUES = ["DRAFT", "PAID", "VOID", "PENDING"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS_VALUES)[number];

export const PRICE_TYPE_VALUES = ["STANDARD", "SPECIAL", "DISCOUNTED", "MANUAL", "PROMO"] as const;
export type PriceType = (typeof PRICE_TYPE_VALUES)[number];

export const CHECK_STATUS_VALUES = ["RECORDED", "DEPOSITED", "CLEARED", "BOUNCED"] as const;
export type CheckStatus = (typeof CHECK_STATUS_VALUES)[number];

export const DOCUMENT_NUMBER_TYPE_VALUES = [
  "INVOICE",
  "ESTIMATE",
  "CREDIT_NOTE",
  "PAYMENT",
  "RETURN",
  "ORDER",
] as const;
export type DocumentNumberType = (typeof DOCUMENT_NUMBER_TYPE_VALUES)[number];

export const COSTING_METHOD_VALUES = ["FIFO", "LIFO", "AVCO", "STANDARD", "LAST_COST"] as const;
export type CostingMethod = (typeof COSTING_METHOD_VALUES)[number];

export const AUTHORIZATION_STATUS_VALUES = [
  "NONE",
  "PENDING_REVIEW",
  "VERIFIED",
  "EXPIRED",
  "REJECTED",
] as const;
export type AuthorizationStatus = (typeof AUTHORIZATION_STATUS_VALUES)[number];

export const AUTHORIZATION_SOURCE_VALUES = ["RETAILER_SUBMITTED", "WHOLESALER_ADDED"] as const;
export type AuthorizationSource = (typeof AUTHORIZATION_SOURCE_VALUES)[number];

/**
 * ⚠️ Drift fixed here (Wave E / imp-10b, L-072): mobile's `BuyerPromotion.type`
 * omitted `"BUY_N_GET_M"` (present in the schema, on web, and already in
 * `apps/mobile/lib/pricing.ts`'s own `PromotionType` — mobile's BOGO matcher
 * worked around the hole with an explicit `as PromotionType` cast, now removed).
 */
export const PROMOTION_TYPE_VALUES = ["PERCENT", "FIXED", "QTY_BREAK", "BUY_N_GET_M"] as const;
export type PromotionType = (typeof PROMOTION_TYPE_VALUES)[number];

export const PROMOTION_SCOPE_VALUES = ["ALL", "CATEGORY", "PRODUCTS"] as const;
export type PromotionScope = (typeof PROMOTION_SCOPE_VALUES)[number];

export const MIGRATION_SOURCE_VALUES = ["ZOHO", "QUICKBOOKS", "CSV", "PAPER"] as const;
export type MigrationSource = (typeof MIGRATION_SOURCE_VALUES)[number];

export const MIGRATION_JOB_STATUS_VALUES = [
  "FETCHING",
  "STAGED",
  "CONFIRMED",
  "UNDONE",
  "FAILED",
] as const;
export type MigrationJobStatus = (typeof MIGRATION_JOB_STATUS_VALUES)[number];

export const STOCK_COUNT_STATUS_VALUES = ["OPEN", "REVIEW", "COMMITTED", "DISCARDED"] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUS_VALUES)[number];

export const SALES_AGENT_STATUS_VALUES = ["ACTIVE", "PAUSED", "STOPPED_FOR_NEW"] as const;
export type SalesAgentStatus = (typeof SALES_AGENT_STATUS_VALUES)[number];

export const COMMISSION_RATE_SOURCE_VALUES = [
  "ORDER_OVERRIDE",
  "CUSTOMER_RATE",
  "AGENT_DEFAULT",
  "NONE",
] as const;
export type CommissionRateSource = (typeof COMMISSION_RATE_SOURCE_VALUES)[number];

export const COMMISSION_ACCRUAL_STATUS_VALUES = [
  "PENDING",
  "PARTIAL",
  "PAYABLE",
  "SETTLED",
  "VOID",
] as const;
export type CommissionAccrualStatus = (typeof COMMISSION_ACCRUAL_STATUS_VALUES)[number];

export const COMMISSION_STATEMENT_STATUS_VALUES = ["PENDING", "APPROVED", "PAID", "VOID"] as const;
export type CommissionStatementStatus = (typeof COMMISSION_STATEMENT_STATUS_VALUES)[number];

export const COMMISSION_STATEMENT_LINE_KIND_VALUES = [
  "CLAIM",
  "ADJUSTMENT",
  "CARRYFORWARD",
] as const;
export type CommissionStatementLineKind = (typeof COMMISSION_STATEMENT_LINE_KIND_VALUES)[number];

export const IMPORT_FILE_STATUS_VALUES = [
  "QUEUED",
  "PROCESSING",
  "CLEAN",
  "NEEDS_REVIEW",
  "DUPLICATE",
  "FAILED",
  "POSTED",
] as const;
export type ImportFileStatus = (typeof IMPORT_FILE_STATUS_VALUES)[number];

export const IMPORT_BATCH_STATUS_VALUES = [
  "PROCESSING",
  "READY",
  "POSTED",
  "PARTIALLY_POSTED",
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUS_VALUES)[number];

export const ROUTE_ORIGIN_KIND_VALUES = ["TENANT", "DRIVER", "ADDRESS"] as const;
export type RouteOriginKind = (typeof ROUTE_ORIGIN_KIND_VALUES)[number];

export const ROUTE_END_KIND_VALUES = ["NONE", "RETURN_TO_START", "DRIVER_HOME", "ADDRESS"] as const;
export type RouteEndKind = (typeof ROUTE_END_KIND_VALUES)[number];

export const ROUTE_OPTIMIZE_METRIC_VALUES = ["TIME", "DISTANCE"] as const;
export type RouteOptimizeMetric = (typeof ROUTE_OPTIMIZE_METRIC_VALUES)[number];

export const CHANGE_REQUEST_TYPE_VALUES = [
  "ADD_ITEM",
  "CHANGE_QTY",
  "REMOVE_ITEM",
  "NOTE",
] as const;
export type ChangeRequestType = (typeof CHANGE_REQUEST_TYPE_VALUES)[number];

export const CHANGE_REQUEST_STATUS_VALUES = ["PENDING", "APPROVED", "DECLINED"] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUS_VALUES)[number];

export const RECURRING_FREQUENCY_VALUES = ["WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCY_VALUES)[number];

export const MOVEMENT_TYPE_VALUES = [
  "PURCHASE",
  "SALE",
  "ADJUSTMENT",
  "RETURN",
  "WRITE_OFF",
  "COST_BASIS",
] as const;
export type MovementType = (typeof MOVEMENT_TYPE_VALUES)[number];

export const CRM_CONNECTION_STATUS_VALUES = [
  "CONNECTED",
  "NEEDS_ATTENTION",
  "DISCONNECTED",
] as const;
export type CrmConnectionStatus = (typeof CRM_CONNECTION_STATUS_VALUES)[number];

export const CRM_TRIGGER_MODE_VALUES = ["STAGE", "WON"] as const;
export type CrmTriggerMode = (typeof CRM_TRIGGER_MODE_VALUES)[number];

export const MAILBOX_PROVIDER_VALUES = ["GOOGLE"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDER_VALUES)[number];

export const MAILBOX_CONNECTION_STATUS_VALUES = ["CONNECTED", "REVOKED", "THROTTLED"] as const;
export type MailboxConnectionStatus = (typeof MAILBOX_CONNECTION_STATUS_VALUES)[number];

export const CRM_HANDOFF_STATUS_VALUES = [
  "PENDING",
  "CREATED",
  "LINKED",
  "WRITEBACK_PENDING",
  "NEEDS_REVIEW",
  "DRY_RUN",
  "SKIPPED",
  "FAILED",
] as const;
export type CrmHandoffStatus = (typeof CRM_HANDOFF_STATUS_VALUES)[number];

// REG-743-F1: the billing plan keys a tenant can be created/downgraded to. Mirrors
// `apps/api/src/billing/plan-catalog.constants.ts`'s `PLAN_KEYS` — the admin "New Tenant" form
// previously hand-typed `["STARTER", "PROFESSIONAL", "ENTERPRISE"]`, a non-existent
// "PROFESSIONAL" key with GROWTH/SCALE missing.
//
// WP1 (lite-L2, REG-743-F4): LITE is an invite-only tier ranked below every existing plan, so it
// leads the array — order pin, not hardcoded indices; keep set-equal to the API's local mirror
// (see `apps/api/src/common/enum-parity.spec.ts`'s REG-743-F4 case).
export const PLAN_KEYS = ["LITE", "STARTER", "GROWTH", "SCALE", "ENTERPRISE"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

// REG-743-N6: pinned set-equal to the generated Prisma `TenantClass` enum (see
// `enum-parity.spec.ts`'s `ENUM_TABLE` row) — consumed by `create-tenant.dto.ts`'s `@IsIn` and
// the admin "New Tenant" form.
export const TENANT_CLASS_VALUES = ["DEMO", "INTERNAL", "PRODUCTION", "TEST"] as const;

// Post-dated check payments PR-1 (additive-only): why a CHECK bounced. Pinned set-equal to the
// generated Prisma `CheckReturnReason` enum (see `enum-parity.spec.ts`'s `ENUM_TABLE` row). No
// read/write path sets or reads this yet — a later PR wires the check-lifecycle transition that
// does.
export const CHECK_RETURN_REASON_VALUES = [
  "NSF",
  "ACCOUNT_CLOSED",
  "STOP_PAYMENT",
  "OTHER",
] as const;
export type CheckReturnReason = (typeof CHECK_RETURN_REASON_VALUES)[number];
export type TenantClass = (typeof TENANT_CLASS_VALUES)[number];

// Feature grants PR-1: per-tenant entitlement override effect. Pinned set-equal to the
// generated Prisma `FeatureOverrideEffect` enum (see `enum-parity.spec.ts`'s `ENUM_TABLE` row).
export const FEATURE_OVERRIDE_EFFECT_VALUES = ["GRANT", "DENY"] as const;
export type FeatureOverrideEffect = (typeof FEATURE_OVERRIDE_EFFECT_VALUES)[number];

// Public demo booking (2026-09-16): pinned set-equal to the generated Prisma
// `DemoBookingStatus` enum (see `enum-parity.spec.ts`'s `ENUM_TABLE` row).
// Consumed by the marketing site's demo-booking client instead of a
// hand-typed local union (lesson L-072: a hand-typed mirror is how three
// real bugs shipped).
export const DEMO_BOOKING_STATUS_VALUES = ["CONFIRMED", "CANCELLED", "COMPLETED"] as const;
export type DemoBookingStatus = (typeof DEMO_BOOKING_STATUS_VALUES)[number];
