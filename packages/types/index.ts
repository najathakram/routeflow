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

// ─── Developer mode (hidden dispatch/driver/route addon) ──────────────────────

/**
 * Legacy TenantAddon.addonKey for the hidden platform-admin "developer mode" flag.
 * Unlocks in-development dispatch/driver/route surfaces on web + mobile.
 * Bridge-to-catalog (later): LEGACY_ADDON_KEY_TO_SKU -> DEV_MODE sku granting flag.dispatch_live.
 */
export const DEVELOPER_MODE_ADDON = "developer_mode";
