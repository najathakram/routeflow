import type { ExpectedPackPayload, ProductPackAtOpen } from "@routeflow/types";

/**
 * SA-797 (row 218): the expected pack an edit save that carries `unit` sends back, the same rule as web's
 * `expectedPackFor` (apps/web/lib/product-edit-unit.ts): the values the form READ when it opened, never a later
 * refetch, so a Settings > Units rename committed while the form was open is a 409 PRODUCT_PACK_STALE instead of
 * being written over. Nothing when the save does not carry `unit`; the tenant unit only when the word was linked.
 */
export function expectedPackFor(
  sentUnit: string | undefined,
  opened: ProductPackAtOpen | undefined | null,
): ExpectedPackPayload | Record<string, never> {
  if (sentUnit === undefined || !opened) return {};
  return {
    expectedUnit: opened.unit,
    expectedUnitsPerBox: opened.unitsPerBox ?? null,
    ...(typeof opened.packTenantUnitId === "string"
      ? { expectedTenantUnitId: opened.packTenantUnitId }
      : {}),
  };
}
