/**
 * Where a buyer lands after picking a seller. One helper for every seller entry point (the
 * sidebar switcher and the seller list) so they cannot drift (W-1296). The portal home applies
 * SA-1211 A1.2: 0 counted orders -> Invoices, otherwise Orders.
 */
export function sellerLandingHref(slug: string): string {
  return `/buyer/portal/${slug}?then=orders`;
}
