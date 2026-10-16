/**
 * L5 (owner 2026-10-13): hiding products from EVERY portal customer is account-admin only, the same bar as the
 * product's own "Hide from portal" switch. The API enforces it on every rule write (row 509: `rule-lock.ts`
 * `assertMayManageRule`); these helpers only decide what to show.
 */

/** The fixed line shown beside a disabled all-portal control. */
export const ASK_ACCOUNT_ADMIN = "Ask an account admin";

/** TENANT_ADMIN, and SUPER_ADMIN (who satisfies every role on the API). */
export function mayHideFromAllPortal(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN" || role === "SUPER_ADMIN";
}

/** Mirrors the API's `isAllCustomerRule`: a FEDERAL rule reaches every portal customer. */
export function hidesFromAllPortalCustomers(rule: { jurisdiction: string }): boolean {
  return rule.jurisdiction === "FEDERAL";
}
