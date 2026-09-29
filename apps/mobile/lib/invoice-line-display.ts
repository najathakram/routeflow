/**
 * B653: the operator invoice detail's per-line qty/unit text (`(operator)/(tabs)/invoices/[id].tsx`).
 * `invoiceLineQtyText` itself now lives in `@routeflow/pricing` (the ONE formatter shared by
 * web/api/mobile — this file's own local copy got the factor-1 unit case wrong: a bare "5"
 * instead of "5 Piece", #1275 review round). `usesUnitDisplay`/`invoiceLineUnitNoun` are this
 * screen's own routing/noun decisions and stay pure + testable here for the same reason
 * `order-line-display.ts`'s helpers do — RN cannot import a web component to assert against.
 */

import type { LineComponentView } from "@routeflow/types";
import { componentSubLineTexts } from "./line-components";

/**
 * Whether a line routes through the unit-aware display (qty text + unit noun) instead of the
 * plain "qty × price" line. A boxed split routes through it as before; a units_v1 FACTOR-1 line
 * (no split — e.g. "5 Piece") has neither boxes nor pieces but DOES carry its own unitLabel, so
 * it must route through it too, or it silently falls back to the plain "5 × $2.00" form with no
 * unit named at all (#1275 review round).
 */
export function usesUnitDisplay(item: {
  boxes?: number | null;
  pieces?: number | null;
  unitLabel?: string | null;
}): boolean {
  return item.boxes != null || item.pieces != null || (item.unitLabel?.trim() ?? "") !== "";
}

/** The box-level noun for the "@ price/<noun>" suffix — "Case" for a units_v1 line, "box" default. */
export function invoiceLineUnitNoun(item: { unitLabel?: string | null }): string {
  return item.unitLabel?.trim() || "box";
}

/** #2717 M3: the sub-line texts under a composed (mixed-pack) invoice line; none for a legacy line. */
export function invoiceLineSubLines(item: { components?: ReadonlyArray<LineComponentView> | null }): string[] {
  return componentSubLineTexts(item.components);
}
