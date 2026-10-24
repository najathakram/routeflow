import { OPERATOR_PERMISSION_GROUP_VALUES, type OperatorPermissionGroup } from "./enums";

// ─── Per-operator feature groups ──────────────────────────────────────────────────────────────
//
// The tenant admin switches feature groups on or off per operator. The server stores the groups that
// are OFF for a user (`User.deniedPermissionGroups`); everything below is the shared vocabulary web and
// mobile render from, so a label or a route mapping is never typed twice.

export interface PermissionGroupInfo {
  key: OperatorPermissionGroup;
  /** The switch label. */
  label: string;
  /** One line under the switch. */
  description: string;
  /** 1-based display position; matches the position in `OPERATOR_PERMISSION_GROUP_VALUES`. */
  order: number;
}

export const PERMISSION_GROUPS: readonly PermissionGroupInfo[] = [
  {
    key: "ORDERS",
    label: "Selling & orders",
    description: "Orders, counter sales, pickups, returns, estimates and order templates.",
    order: 1,
  },
  {
    key: "DISPATCH",
    label: "Dispatch & delivery",
    description: "Routes, route runs, drivers, trips and delivery planning.",
    order: 2,
  },
  {
    key: "CUSTOMERS",
    label: "Customers & buyer portal",
    description: "Customer records, contacts, documents, portal invites and customer messages.",
    order: 3,
  },
  {
    key: "CATALOG",
    label: "Catalog & inventory",
    description: "Products, stock, counts, purchase orders, suppliers and inventory settings.",
    order: 4,
  },
  {
    key: "PRICING",
    label: "Pricing, costs & margins",
    description: "Customer prices, promotions, cost basis, valuation and margin settings.",
    order: 5,
  },
  {
    key: "REGULATED",
    label: "Regulated items",
    description: "Regulated products, selling restrictions, labels and customer authorizations.",
    order: 6,
  },
  {
    key: "FINANCE",
    label: "Invoices & payments",
    description: "Invoices, payments, credit notes, supplier bills, expenses and commissions.",
    order: 7,
  },
  {
    key: "NOTIFICATIONS",
    label: "Notifications",
    description: "Notification rules, templates, quiet hours and the delivery log.",
    order: 8,
  },
  {
    key: "REPORTS",
    label: "Reports & analytics",
    description: "Analytics, product insights, bookkeeping reports and finance dashboards.",
    order: 9,
  },
];

/**
 * When each group was introduced, and how an operator whose access an admin has already narrowed
 * is treated for it. Keyed by EVERY enum value (a `Record`, so adding a group without an entry does
 * not compile). `restrictedDefault` is the state of the group for an operator with a non-empty deny
 * list when the group first ships: "ON" is allowed only for the baseline groups; a later group that
 * ships "ON" for restricted operators needs an explicit decision recorded next to its entry.
 */
export const GROUP_INTRODUCED: Record<
  OperatorPermissionGroup,
  { addedIn: string; restrictedDefault: "OFF" | "ON" }
> = {
  ORDERS: { addedIn: "2026-10", restrictedDefault: "ON" },
  DISPATCH: { addedIn: "2026-10", restrictedDefault: "ON" },
  CUSTOMERS: { addedIn: "2026-10", restrictedDefault: "ON" },
  CATALOG: { addedIn: "2026-10", restrictedDefault: "ON" },
  PRICING: { addedIn: "2026-10", restrictedDefault: "ON" },
  REGULATED: { addedIn: "2026-10", restrictedDefault: "ON" },
  FINANCE: { addedIn: "2026-10", restrictedDefault: "ON" },
  NOTIFICATIONS: { addedIn: "2026-10", restrictedDefault: "ON" },
  REPORTS: { addedIn: "2026-10", restrictedDefault: "ON" },
};

/** Whether the permission check only reports (`shadow`) or applies (`live`) the groups. */
export type PermissionsMode = "shadow" | "live";

export type MyPermissionsRole = "SUPER_ADMIN" | "TENANT_ADMIN" | "OPERATOR" | "DRIVER" | "CUSTOMER";

/** Payload of `GET /users/me/permissions`. */
export interface MyPermissions {
  role: MyPermissionsRole;
  /** True for the account admin (and the platform super admin); false for everyone else. */
  isAccountAdmin: boolean;
  /** The groups the caller effectively holds. Empty for drivers and customers. */
  groups: OperatorPermissionGroup[];
  /** Compare-and-set token for `SetOperatorPermissionsBody.expectedVersion`. */
  version: number;
  mode: PermissionsMode;
}

/** Body of `PUT /users/:id/permissions`. `granted` is the full set of groups that are ON. */
export interface SetOperatorPermissionsBody {
  granted: OperatorPermissionGroup[];
  expectedVersion: number;
}

/** Every group, in display order (a fresh array each call; safe to mutate). */
export function allPermissionGroups(): OperatorPermissionGroup[] {
  return [...OPERATOR_PERMISSION_GROUP_VALUES];
}

// ─── Route -> group map ───────────────────────────────────────────────────────────────────────

export interface PermissionRouteEntry {
  /** A dashboard path prefix, matched on whole path segments. */
  prefix: string;
  /** Holding ANY of these groups opens the route. */
  anyOf: readonly OperatorPermissionGroup[];
}

/**
 * Dashboard routes that belong to a feature group. A path with no entry (dashboard home, settings
 * hub, anything not listed) is open to every operator. The longest matching prefix wins, so a more
 * specific entry may narrow or widen its parent.
 */
export const PERMISSION_ROUTE_MAP: readonly PermissionRouteEntry[] = [
  { prefix: "/orders", anyOf: ["ORDERS"] },
  { prefix: "/returns", anyOf: ["ORDERS"] },
  { prefix: "/estimates", anyOf: ["ORDERS"] },
  { prefix: "/deliveries", anyOf: ["ORDERS", "DISPATCH"] },
  { prefix: "/dispatch", anyOf: ["DISPATCH"] },
  { prefix: "/routes", anyOf: ["DISPATCH"] },
  { prefix: "/drivers", anyOf: ["DISPATCH"] },
  { prefix: "/customers", anyOf: ["CUSTOMERS"] },
  { prefix: "/products", anyOf: ["CATALOG"] },
  { prefix: "/inventory", anyOf: ["CATALOG"] },
  { prefix: "/suppliers", anyOf: ["CATALOG"] },
  { prefix: "/purchase-orders", anyOf: ["CATALOG"] },
  { prefix: "/promotions", anyOf: ["PRICING"] },
  { prefix: "/tobacco", anyOf: ["REGULATED"] },
  { prefix: "/compliance", anyOf: ["REGULATED"] },
  { prefix: "/settings/restrictions", anyOf: ["REGULATED"] },
  { prefix: "/settings/product-categories", anyOf: ["REGULATED"] },
  { prefix: "/invoices", anyOf: ["FINANCE"] },
  { prefix: "/credit-notes", anyOf: ["FINANCE"] },
  { prefix: "/vendor-bills", anyOf: ["FINANCE"] },
  { prefix: "/sales-agents", anyOf: ["FINANCE"] },
  { prefix: "/finance", anyOf: ["FINANCE"] },
  { prefix: "/finance/dashboard", anyOf: ["FINANCE", "REPORTS"] },
  { prefix: "/finance/reports", anyOf: ["REPORTS"] },
  { prefix: "/bookkeeping", anyOf: ["FINANCE", "REPORTS"] },
  { prefix: "/analytics", anyOf: ["REPORTS"] },
];

function normalizePath(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * The groups that open `path` (any one is enough), or `null` when the route is not tied to a group.
 * Matches the longest `PERMISSION_ROUTE_MAP` prefix on whole path segments, so `/orders/12` matches
 * `/orders` but `/ordersx` does not. Query string and hash are ignored.
 */
export function permissionForPath(path: string): OperatorPermissionGroup[] | null {
  const target = normalizePath(path);
  let best: PermissionRouteEntry | null = null;
  for (const entry of PERMISSION_ROUTE_MAP) {
    const hit = target === entry.prefix || target.startsWith(`${entry.prefix}/`);
    if (hit && (best === null || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best ? [...best.anyOf] : null;
}
