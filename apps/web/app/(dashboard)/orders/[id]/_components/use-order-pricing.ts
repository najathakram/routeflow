import * as React from "react";
import { customerLinePrice } from "@routeflow/pricing";
import { useCustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";
import { lineIsSpecialAt } from "@/lib/order-line-unit";

/** What the per-line SPECIAL judgement reads off an edit line (S19b). */
export type SpecialLine = {
  unitLabel?: string | null;
  derivedBase?: unknown;
  unit?: string;
  packUnit?: string;
  packUnitsPerBox?: number | null;
  unitsPerBox?: number | null;
};
const specialProductOf = (line?: SpecialLine) =>
  line
    ? { unit: line.packUnit ?? line.unit, unitsPerBox: line.packUnitsPerBox ?? line.unitsPerBox }
    : undefined;

/**
 * The order-edit page's customer pricing: the customer's price layer (S19b) plus the tier-aware price / SPECIAL
 * callbacks `EditableLineItems` and the save-time reason check share. Extracted from page.tsx; the page keeps the
 * customer's tier lookup (`tierForProductId`) and hands it in.
 */
export function useOrderCustomerPricing(
  customerId: string | null | undefined,
  tierForProductId: (productId: string) => number,
) {
  const priceLayer = useCustomerPriceLayer(customerId);
  const tierPriceFor = React.useCallback(
    (p: { id: string }) =>
      customerLinePrice({
        product: p as unknown as Record<string, unknown>,
        tier: tierForProductId(p.id),
        layer: priceLayer.layerOf(p.id),
      }).price,
    [tierForProductId, priceLayer.layerOf],
  );
  // Per line (S19b integration review): a unit line answers with its own unit's layer row, like mobile's lineIsSpecial.
  // B465: the id-only variant serves call sites that only have `productId` (an EditItemState line, not a full
  // SubstituteOption/product row) — same rule, shared so the save-time guard and the row's own render never drift.
  const isSpecialTierForProductId = React.useCallback(
    (productId: string, line?: SpecialLine) =>
      lineIsSpecialAt({
        tier: tierForProductId(productId),
        layer: priceLayer.layerOf(productId),
        line,
        product: specialProductOf(line),
      }),
    [tierForProductId, priceLayer.layerOf],
  );
  const isSpecialTierFor = React.useCallback(
    (p: { id: string }, line?: SpecialLine) => isSpecialTierForProductId(p.id, line),
    [isSpecialTierForProductId],
  );
  return { priceLayer, tierPriceFor, isSpecialTierFor, isSpecialTierForProductId };
}
