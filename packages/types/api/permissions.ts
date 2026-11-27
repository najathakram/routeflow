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
  {
    key: "BAD_DEBT",
    label: "Write off bad debts",
    description: "Write off an invoice nobody will pay, and reinstate it if they pay later.",
    order: 10,
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
  // SA-1050 (owner 2026-10-20, "off by default"): the first group that ships OFF. Every later group keeps default-on.
  BAD_DEBT: { addedIn: "2026-10", restrictedDefault: "OFF" },
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
  /**
   * May the caller type a line price (SA-1034)? The server's MODE-APPLIED answer: in `shadow` the role alone, in `live` the
   * role and the deny list. The web reads this, never a role, to enable or disable "Add custom item".
   */
  priceEditAllowed: boolean;
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

/**
 * One dashboard route's access. Either a feature-group gate (`anyOf`: holding ANY of the groups opens it) or an
 * explicit group-free level: `BASE` (any operator, on purpose) or `ADMIN` (the page itself is the account admin's).
 * A route with no entry at all is UNKNOWN (see `routeAccess`), never open.
 */
export type PermissionRouteEntry =
  | {
      /** A dashboard path prefix, matched on whole path segments. */
      prefix: string;
      /** Holding ANY of these groups opens the route. */
      anyOf: readonly OperatorPermissionGroup[];
    }
  | {
      /** A dashboard path prefix, matched on whole path segments. */
      prefix: string;
      /** No feature group on purpose: BASE = any operator, ADMIN = the account admin only. */
      access: "BASE" | "ADMIN";
    };

/**
 * Dashboard routes and who may open them. CLOSED WORLD: every top-level dashboard directory has an entry
 * (apps/api/src/common/surface-inventory.spec.ts pins it), and a path with NO entry is UNKNOWN, not open to
 * everyone (`routeAccess`). The longest matching prefix wins, so a more specific entry may narrow or widen its parent.
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
  // The page reads useInvoices({ shipped: true }) -> InvoicesController.findAll (FINANCE).
  { prefix: "/shipments", anyOf: ["FINANCE"] },
  // Product insights: ProductInsightsController.* (REPORTS).
  { prefix: "/insights", anyOf: ["REPORTS"] },
  // Group-free on purpose (any operator): home, the settings hub (its sub-pages /settings/restrictions and
  // /settings/product-categories narrow to REGULATED above), the onboarding checklist and the app-install page.
  { prefix: "/dashboard", access: "BASE" },
  { prefix: "/settings", access: "BASE" },
  { prefix: "/getting-started", access: "BASE" },
  { prefix: "/get-the-app", access: "BASE" },
  // Reads billing plans / subscription / usage / recommendation (UNGUARDED or BASE on the server). The page has no
  // role check of its own; its writes (subscribe, upgrade, cancel ...) are ADMIN-only on the server, so BASE here.
  { prefix: "/choose-plan", access: "BASE" },
  // A bare client redirect to /vendor-bills (which carries FINANCE); the page itself refuses nobody, so BASE.
  { prefix: "/purchases", access: "BASE" },
];

function normalizePath(path: string): string {
  const cut = path.search(/[?#]/);
  const bare = cut === -1 ? path : path.slice(0, cut);
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The access verdict for a dashboard path: a group gate, any-operator (BASE), admin-only (ADMIN), or no entry (UNKNOWN). */
export type RouteAccess =
  | { kind: "GROUPS"; anyOf: OperatorPermissionGroup[] }
  | { kind: "BASE" }
  | { kind: "ADMIN" }
  | { kind: "UNKNOWN" };

function matchRouteEntry(path: string): PermissionRouteEntry | null {
  const target = normalizePath(path);
  let best: PermissionRouteEntry | null = null;
  for (const entry of PERMISSION_ROUTE_MAP) {
    const hit = target === entry.prefix || target.startsWith(`${entry.prefix}/`);
    if (hit && (best === null || entry.prefix.length > best.prefix.length)) best = entry;
  }
  return best;
}

/**
 * Who may open `path`. Matches the longest `PERMISSION_ROUTE_MAP` prefix on whole path segments, so `/orders/12`
 * matches `/orders` but `/ordersx` does not. Query string and hash are ignored. A path with no entry is UNKNOWN
 * (closed): callers treat it as not allowed.
 */
export function routeAccess(path: string): RouteAccess {
  const entry = matchRouteEntry(path);
  if (!entry) return { kind: "UNKNOWN" };
  if ("anyOf" in entry) return { kind: "GROUPS", anyOf: [...entry.anyOf] };
  return { kind: entry.access };
}

/**
 * The groups that open `path` (any one is enough), or `null` when the route is not tied to a group (a BASE or ADMIN
 * entry, or no entry). Unchanged for existing callers; use `routeAccess` to tell those cases apart.
 */
export function permissionForPath(path: string): OperatorPermissionGroup[] | null {
  const access = routeAccess(path);
  return access.kind === "GROUPS" ? access.anyOf : null;
}
