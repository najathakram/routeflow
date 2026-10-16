import type { ExpectedPackPayload, ProductPackAtOpen } from "@routeflow/types";

/**
 * The `unit` (pack word) a product-form save may send. Only a word the operator actually changed:
 * a form opened before a Settings > Units rename holds the OLD word, and sending it back would
 * silently undo the rename on that product. Blank = leave unchanged.
 */
export function packWordToSend(
  draftUnit: string | undefined,
  unitWhenEditStarted: string | undefined,
): string | undefined {
  const next = draftUnit?.trim();
  if (!next || next === (unitWhenEditStarted ?? "").trim()) return undefined;
  return draftUnit;
}

/**
 * SA-797 (row 218): the expected pack a save that carries `unit` sends back — the values the form READ when it
 * opened, never the latest refetch, so a rename committed while the form was open is a 409 instead of being
 * written over. Nothing when the save does not carry `unit`. The tenant unit only when the word was linked.
 */
export function expectedPackFor(
  sentUnit: string | undefined,
  opened: ProductPackAtOpen | undefined,
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
