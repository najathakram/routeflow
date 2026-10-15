import { componentSubLineText } from "@routeflow/pricing";
import type { LineComponentView } from "@routeflow/types";

/**
 * #2717 M3 (case 34, L-225): the sub-line texts of a composed (mixed-pack) line, "(included)": the
 * box line stays authoritative and these carry no money. Both the invoice line display and the
 * order card model call THIS, which calls the ONE shared `componentSubLineText`. Position order;
 * a Prisma Decimal arrives as a string, so the stored price is coerced. A legacy line yields none.
 */
export function componentSubLineTexts(
  components: ReadonlyArray<LineComponentView> | null | undefined,
): string[] {
  return [...(components ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((c) =>
      componentSubLineText({
        name: c.name,
        qty: Number(c.qty),
        unitSku: c.unitSku,
        unitBarcode: c.unitBarcode,
        displayUnitPrice4: c.displayUnitPrice4 == null ? null : Number(c.displayUnitPrice4),
      }),
    );
}
