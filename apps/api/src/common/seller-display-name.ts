/**
 * The seller's display name as a buyer or a platform surface shows it: the business name when set (and not blank), else the
 * tenant's own name, else `fallback`. ONE expression for every caller (row 397 / SA-973): the pin in `seller-display-name.spec.ts`
 * fails on a hand-written copy of it anywhere else in apps/api/src.
 */
export function sellerDisplayName(
  config: { businessName?: string | null } | null | undefined,
  tenant: { name?: string | null } | null | undefined,
  fallback = "",
): string {
  return config?.businessName?.trim() || tenant?.name?.trim() || fallback;
}
