// ─── Enums (synced with apps/api/prisma/schema/*.prisma) ────────────────────────

export enum UserRole {
  OPERATOR = "OPERATOR",
  TENANT_ADMIN = "TENANT_ADMIN",
  CUSTOMER = "CUSTOMER",
  DRIVER = "DRIVER",
  SUPER_ADMIN = "SUPER_ADMIN",
}

export enum UserStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  SUSPENDED = "SUSPENDED",
}

export enum OrderStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  OUT_FOR_DELIVERY = "OUT_FOR_DELIVERY",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
}

export enum ItemStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  PARTIAL = "PARTIAL",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
}

export enum RouteRunStatus {
  SCHEDULED = "SCHEDULED",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export enum RouteRunStopStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  SKIPPED = "SKIPPED",
}

export enum MutationType {
  DELIVERED = "DELIVERED",
  PARTIAL = "PARTIAL",
  REFUSED = "REFUSED",
  ADD_ON = "ADD_ON",
  SUBSTITUTED = "SUBSTITUTED",
}

export enum TxnStatus {
  UNPAID = "UNPAID",
  PARTIAL = "PARTIAL",
  PAID = "PAID",
}

export enum PaymentMethod {
  CASH = "CASH",
  CHECK = "CHECK",
  ACH = "ACH",
  OTHER = "OTHER",
  CREDIT_NOTE = "CREDIT_NOTE",
  ADVANCE = "ADVANCE",
  CREDIT_CARD = "CREDIT_CARD",
  ZELLE = "ZELLE",
}

export enum FulfillPath {
  ROUTE = "ROUTE",
  SHIP = "SHIP",
}

export enum RouteKind {
  SCHEDULED = "SCHEDULED",
  ADHOC = "ADHOC",
}

export enum DriverStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
}

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface Order {
  id: string;
  orderNumber?: string;
  status: OrderStatus;
  customerId: string;
  routeRunId?: string;
  subtotal: number;
  tax: number;
  total: number;
  urgent: boolean;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ApiResponse<T> {
  data: T;
  message: string;
  success: boolean;
}

// ─── Pack size (Product.unitsPerBox capture) ──────────────────────────────────

export type { PackSizeConfidence, PackSizeParse, PackSizeSuggestion } from "./pack-size";
export { formatCountList, parsePackSizeDetailed, suggestPackSize } from "./pack-size";

// ─── Trip grouping (ad-hoc trip stop grouping helper) ─────────────────────────

export * from "./trip-grouping";

// ─── Shared API DTOs + Prisma-enum parity (wave E / imp-10b) ──────────────────
//
// Request/response shapes duplicated identically (or near-identically) between
// apps/web/lib/api/* and apps/mobile/lib/api/* — moved here per the DTO sweep
// (`.claude/pipeline/wave-E-structure/2026-09-03-imp-10b-shared-dtos/sweep.md`).
// Prisma-enum mirrors live in `./api/enums.ts`, pinned set-equal to
// `@prisma/client` by `apps/api/src/common/enum-parity.spec.ts`.

export * from "./api/enums";
export * from "./api/billing";
export * from "./api/orders";
export * from "./api/customers";
export * from "./api/products";
export * from "./api/finance";
export * from "./api/returns";
export * from "./api/regulated";
export * from "./api/routes";
export * from "./api/buyer";
export * from "./api/misc";
export * from "./api/invoices";
export * from "./api/crm";
export * from "./api/checks";

// ─── Developer mode (hidden dispatch/driver/route addon) ──────────────────────

/**
 * Legacy TenantAddon.addonKey for the hidden platform-admin "developer mode" flag.
 * Owner decision 2026-08-28: `developer_mode` unlocks ONLY genuinely in-development
 * surfaces — today that's the mobile `(driver)` app section, the mobile role-picker
 * driver option, and the mobile `(tenant)` dispatch tab. It no longer unlocks the two
 * GA delivery addons (`recurring_routes` / `order_delivery`) anywhere in client UI —
 * client gates read the feature addon alone via `useRoutesAccess`/`useDeliveryAccess`.
 * The dispatch API still accepts it as an any-of key on `@RequireAddon` purely so a
 * dev tenant can exercise those in-dev surfaces end-to-end.
 * Bridge-to-catalog (later): LEGACY_ADDON_KEY_TO_SKU -> DEV_MODE sku granting flag.dispatch_live.
 */
export const DEVELOPER_MODE_ADDON = "developer_mode";

/**
 * TenantAddon.addonKey gating at-door payment collection by drivers (owner
 * decision 2026-08-24: OPT-IN per tenant — acme collects at the door,
 * acme-distribution bills on account only). Server-enforced: complete-with-payment
 * 403s without it; the plain complete endpoint (deliveries + POD +
 * auto-invoice, no money) is always available.
 */
export const DRIVER_PAYMENTS_ADDON = "driver_payments";

/**
 * Per-tenant feature addons for the two delivery products (owner decision
 * 2026-08-25): tenants may run standing routes, ad-hoc order delivery, or both.
 * Owner decision 2026-08-28: `developer_mode` no longer unlocks either of these —
 * client gates read the feature addon alone (`useRoutesAccess`/`useDeliveryAccess`).
 * Server-side, the dispatch API accepts `developer_mode` as an any-of alongside
 * these keys so dev tenants can still exercise in-dev surfaces end-to-end.
 */
export const RECURRING_ROUTES_ADDON = "recurring_routes";
export const ORDER_DELIVERY_ADDON = "order_delivery";

/**
 * TenantAddon.addonKey gating the AI document-reading features (owner decision
 * 2026-08-28): vendor-bill scan, batch invoice scan, supplier-statement scan,
 * and expense-receipt extraction. Gated via @RequireAddon("ocr") on those
 * endpoints; the gate's rollout state lives in
 * apps/api/src/billing/addon-gate-registry.ts and currently ships `dark`
 * (allow + would-deny warn, no 403) — it flips to `enforced` only after the
 * owner runs apps/api/scripts/report-addon-gate-blast-radius.mjs. Granted from
 * the platform-admin tenant page or via the OCR_PACK_250 SKU bridge.
 * ⚠️ Web/mobile entry surfaces are NOT yet hidden behind
 * `useHasAddon(OCR_ADDON)` — follow-up owed; until then, tenants without the
 * addon still see scan buttons (and will get 403s once the key is enforced).
 * Route insights are NOT covered by this key.
 */
export const OCR_ADDON = "ocr";
