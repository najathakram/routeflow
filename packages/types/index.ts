// ─── Enums (synced with apps/api/prisma/schema.prisma) ────────────────────────

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
 * decision 2026-08-24: OPT-IN per tenant — affa collects at the door,
 * bb-distro bills on account only). Server-enforced: complete-with-payment
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
