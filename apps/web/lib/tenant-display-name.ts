/**
 * The tenant's display name on a platform-admin surface: the business name when set (and not blank), else the tenant's
 * own name. ONE expression for every platform-admin caller (row 397 / SA-973, the web twin of the API's
 * `sellerDisplayName`): `tenant-display-name.test.ts` fails on a hand-written copy under app/(platform-admin).
 */
export function tenantDisplayName(tenant: { businessName?: string | null; name: string }): string {
  return tenant.businessName?.trim() || tenant.name;
}
