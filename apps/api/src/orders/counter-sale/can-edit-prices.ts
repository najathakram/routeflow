import { UserRole } from "@prisma/client";

/**
 * POS-5: may this caller change a counter-sale line's price (a one-time override, a percent or amount off)?
 *
 * ONE predicate, today ADMIN-ONLY: TENANT_ADMIN or SUPER_ADMIN. An OPERATOR, a driver, a customer and a missing
 * user are all false.
 *
 * Follow-up (NOT here yet): when the operator-permissions "Pricing, costs & margins" grant lands, it slots in at
 * this single predicate and nowhere else (`|| (role === OPERATOR && has(PRICING))`), with the SAME rule in the web
 * copy, and live only at the permissions flip. No call site may copy this check.
 *
 * Mirrored by `apps/web/lib/can-edit-prices.ts` (web never imports API source, the API never value-imports
 * `@routeflow/types`); both specs pin the SAME role table.
 */
export function canEditPrices(user: { role?: string | null } | null | undefined): boolean {
  const role = user?.role;
  return role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN;
}
