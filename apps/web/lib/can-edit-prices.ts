/**
 * POS-5: may this user change a counter-sale line's price (a one-time price, a percent or an amount off)?
 *
 * ONE predicate, today ADMIN-ONLY: TENANT_ADMIN or SUPER_ADMIN. An OPERATOR, a driver, a customer, a missing
 * user and an unknown role are all false. The operator-permissions "Pricing, costs & margins" grant will slot
 * in HERE and nowhere else (live only at the permissions flip). The server applies the SAME rule in
 * `apps/api/src/orders/counter-sale/can-edit-prices.ts`; both specs pin the same role table.
 */
export function canEditPrices(user: { role?: string | null } | null | undefined): boolean {
  const role = user?.role;
  return role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
}
