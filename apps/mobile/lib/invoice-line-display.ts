/**
 * B653: the operator invoice detail's per-line qty/unit text (`(operator)/(tabs)/invoices/[id].tsx`).
 * `invoiceLineQtyText` itself now lives in `@routeflow/pricing` (the ONE formatter shared by
 * web/api/mobile — this file's own local copy got the factor-1 unit case wrong: a bare "5"
 * instead of "5 Piece", #1275 review round). `usesUnitDisplay`/`invoiceLineUnitNoun` are this
 * screen's own routing/noun decisions and stay pure + testable here for the same reason
 * `order-line-display.ts`'s helpers do — RN cannot import a web component to assert against.
 */

import { invoiceDisplayLines, plural } from "@routeflow/pricing";
import type { InvoiceDisplayUnitView, LineComponentView } from "@routeflow/types";
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
export function invoiceLineSubLines(item: {
  components?: ReadonlyArray<LineComponentView> | null;
}): string[] {
  return componentSubLineTexts(item.components);
}

/**
 * #2055: the price suffix ("$X / <noun> of <upb>") names a line's own unit and its pack
 * size independently of any UI-mode gate (a screen's own `isBoxed`-style flag may
 * legitimately exclude a unit-sold line from a box/piece STEPPER, but that is a
 * different concern from what to show here). A genuinely packed line (upb > 1) always
 * gets "noun of upb", whether or not it also carries a `unitLabel` — the operator
 * order-detail screen's own edit-items counterpart used to read bare "/ Case" for a
 * boxed units_v1 line (`isBoxed`'s own `!unitLabel` exclusion skipped the "of upb"
 * branch entirely), losing the pack-size context the order-detail screen's OWN,
 * separately-fixed suffix already shows (#2046, B757). Falls back to a factor-1 line's
 * own `unitLabel`, then the plain `unit`, then nothing.
 */
export function priceUnitSuffix(
  item: { unitLabel?: string | null; unit?: string | null },
  upb: number,
): string {
  if (upb > 1) return ` / ${invoiceLineUnitNoun(item)} of ${upb}`;
  if (item.unitLabel) return ` / ${item.unitLabel}`;
  if (item.unit) return ` / ${item.unit}`;
  return "";
}

const money2 = (n: number): string => `$${n.toFixed(2)}`;
const money4 = (n: number): string => `$${n.toFixed(4)}`;

/**
 * SA-827: the text around an invoice item's own card. All amounts and unit prices come from
 * `invoiceDisplayLines` (@routeflow/pricing); this only formats them.
 * - `today`: `subLines` are the existing component sub-lines (identical to `invoiceLineSubLines`).
 * - `pieces`: `pieces` swaps ONLY the qty/price text of the card's meta line; the discount, notes,
 *   MSRP and free-units lines stay.
 * - `components`: `leading` is one row per component (printed BEFORE the card's own lines, which are
 *   the group), `trailing` the category-tax line (printed AFTER them). No sub-lines.
 */
export function invoiceDisplayRowTexts(item: {
  description: string;
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  unitPrice: number | string;
  subtotal: number | string;
  categoryTax?: { name: string; amount: number | string } | null;
  components?: ReadonlyArray<LineComponentView> | null;
  displayUnit?: InvoiceDisplayUnitView | null;
}): {
  layout: "today" | "pieces" | "components";
  leading: string[];
  subLines: string[];
  pieces: { qtyText: string; priceText: string } | null;
  trailing: string[];
} {
  const res = invoiceDisplayLines(
    {
      description: item.description,
      qty: Number(item.qty),
      boxes: item.boxes,
      pieces: item.pieces,
      unitsPerBox: item.unitsPerBox,
      unitLabel: item.unitLabel,
      unitPrice: Number(item.unitPrice),
      subtotal: Number(item.subtotal),
      categoryTax: item.categoryTax
        ? { name: item.categoryTax.name, amount: Number(item.categoryTax.amount) }
        : null,
    },
    (item.components ?? []).map((c) => ({
      componentProductId: c.componentProductId,
      name: c.name,
      qty: Number(c.qty),
      unitSku: c.unitSku,
      unitBarcode: c.unitBarcode,
      displayUnitPrice4: c.displayUnitPrice4 == null ? null : Number(c.displayUnitPrice4),
      position: c.position,
    })),
    item.displayUnit,
  );
  if (res.layout === "today") {
    return { layout: "today", leading: [], subLines: res.subLines, pieces: null, trailing: [] };
  }
  if (res.layout === "pieces") {
    return {
      layout: "pieces",
      leading: [],
      // A composed line that fell back to pieces (component sums mismatch) keeps today's "(included)" sub-lines.
      subLines: componentSubLineTexts(item.components),
      pieces: {
        qtyText: `${res.qty} ${plural(res.unitLabel, res.qty)}`,
        priceText: money4(res.unitPrice),
      },
      trailing: [],
    };
  }
  const leading = res.rows.map((r) => {
    const tail = [r.unitSku ? `SKU ${r.unitSku}` : null, r.unitBarcode].filter(Boolean);
    return (
      `${r.name} × ${r.qty} ${plural(r.unitLabel, r.qty)} @ ${money4(r.unitPrice)} — ${money2(r.amount)}` +
      (tail.length ? ` | ${tail.join(" | ")}` : "")
    );
  });
  return {
    layout: "components",
    leading,
    subLines: [],
    pieces: null,
    trailing: res.categoryTax
      ? [`${res.categoryTax.label} — ${money2(res.categoryTax.amount)}`]
      : [],
  };
}
