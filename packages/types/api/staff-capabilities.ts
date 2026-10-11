// ─── Staff capability table (SA-762r Ruling A) ───────────────────────────────────────────────────────
//
// ONE capability helper per action: which roles may do it, and which operator permission group can
// switch it off for an OPERATOR. The web (`staffMay(session.role, ...)`) imports this file; the API keeps a
// literal duplicate at apps/api/src/auth/permissions/staff-capabilities.ts (the API never value-imports
// @routeflow/types, L-261), pinned deep-equal to this one by staff-capabilities-parity.spec.ts.
//
// A new action (REFUND_CASH, EDIT_COST) is a row here + its API literal, never a second predicate.

export const STAFF_CAPABILITY_VALUES = [
  "EDIT_LINE_PRICE",
  "VOID_SALE",
  "USE_POS_MODE",
  "EDIT_AFTER_FINAL",
] as const;
export type StaffCapability = (typeof STAFF_CAPABILITY_VALUES)[number];

/** The roles a staff capability can name (a DRIVER or CUSTOMER is never in a row). */
export type StaffCapabilityRole = "OPERATOR" | "TENANT_ADMIN" | "SUPER_ADMIN";

/** The operator permission groups a staff capability can hang off today (widens to OperatorPermissionGroup). */
export type StaffCapabilityGroup = "PRICING" | "ORDERS" | "FINANCE";

export interface StaffCapabilityRule {
  roles: readonly StaffCapabilityRole[];
  group: StaffCapabilityGroup;
}

export const STAFF_CAPABILITY_RULES: Record<StaffCapability, StaffCapabilityRule> = {
  // SUPER_ADMIN joins when the orders/invoices price paths move onto staffMay (perms PR7).
  EDIT_LINE_PRICE: { roles: ["OPERATOR", "TENANT_ADMIN"], group: "PRICING" },
  VOID_SALE: { roles: ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"], group: "ORDERS" },
  // POS mode (SA-763r): a staff order on the PICKUP path, whatever the tenant offers to buyers.
  USE_POS_MODE: { roles: ["OPERATOR", "TENANT_ADMIN"], group: "ORDERS" },
  // Edits to an order whose invoice is already final (SA-763r P-3 reads this row).
  EDIT_AFTER_FINAL: { roles: ["OPERATOR", "TENANT_ADMIN"], group: "FINANCE" },
};

/**
 * May `role` do `action`? Pure. TENANT_ADMIN and SUPER_ADMIN ignore `deniedGroups`; an OPERATOR is refused
 * when the action's group is denied. Every call site passes no `deniedGroups` today (shadow: no visible
 * change); perms PR7 passes the caller's effective denials, one argument per call site.
 */
export function staffMay(
  role: string | null | undefined,
  action: StaffCapability,
  deniedGroups: readonly string[] = [],
): boolean {
  const rule = STAFF_CAPABILITY_RULES[action];
  if (!role || !(rule.roles as readonly string[]).includes(role)) return false;
  if (role === "OPERATOR" && deniedGroups.includes(rule.group)) return false;
  return true;
}

// ─── Counter-sale void window (owner Q-762-1 = A) ────────────────────────────────────────────────

export const COUNTER_VOID_WINDOW_VALUES = ["SAME_TENANT_DAY_BEFORE_CLOSE"] as const;
export type CounterVoidWindow = (typeof COUNTER_VOID_WINDOW_VALUES)[number];

/** The one policy in force. A later per-tenant setting feeds `voidWindowAllows` instead. */
export const COUNTER_VOID_WINDOW: CounterVoidWindow = "SAME_TENANT_DAY_BEFORE_CLOSE";

/**
 * May a counter sale still be voided? Pure: the caller computes the inputs.
 *  - `saleCreatedAt`  the order's real creation instant.
 *  - `nowTenantDay`   [start, end) REAL instants of today's calendar day in the TENANT zone (startOfLocalDay of
 *                     today and tomorrow, the way counter-sale-today builds its window), never a UTC day.
 *  - `windowClosed`   the sale's day has been closed out (false until the day-close lands).
 */
export function voidWindowAllows(
  policy: CounterVoidWindow,
  ctx: { saleCreatedAt: Date; nowTenantDay: { start: Date; end: Date }; windowClosed: boolean },
): boolean {
  switch (policy) {
    case "SAME_TENANT_DAY_BEFORE_CLOSE": {
      if (ctx.windowClosed) return false;
      const at = ctx.saleCreatedAt.getTime();
      return at >= ctx.nowTenantDay.start.getTime() && at < ctx.nowTenantDay.end.getTime();
    }
    default: {
      const unreachable: never = policy;
      return unreachable;
    }
  }
}
