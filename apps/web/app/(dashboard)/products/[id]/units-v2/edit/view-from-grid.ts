import { priceGrid, type LadderView, type TierRules } from "@routeflow/pricing";
import type { ProductPriceGridDto, ProductPriceGridRowDto } from "@routeflow/types";

/** The grid DTO as a pricing LadderView: a positive Set cell is Set, anything else Auto. */
export function viewFromGrid(g: ProductPriceGridDto): LadderView {
  const rows = [...g.rows]
    .sort((a, b) => b.factor - a.factor)
    .map((r) => ({
      ref: r.ref,
      label: r.label,
      factor: r.factor,
      kind: r.kind,
      set: [1, 2, 3, 4, 5].map((t) => {
        const c = r.cells.find((x) => x.tier === t);
        return c && c.source === "set" && c.value > 0 ? c.value : null;
      }),
    }));
  return { rows, anchor: g.anchor, tierAnchors: g.tierAnchors ?? {} };
}

/** The tenant's tier rules as the server served them (missing = the default, no rule). */
export const rulesFromGrid = (g: ProductPriceGridDto): TierRules => g.tierRules ?? {};

/** The draft view as grid rows (barcodes kept), so Auto placeholders show the draft values. */
export function previewRows(
  view: LadderView,
  rules: TierRules,
  g: ProductPriceGridDto,
): ProductPriceGridRowDto[] {
  return priceGrid(view, rules).map((r) => ({
    ref: r.ref,
    label: r.label,
    factor: r.factor,
    kind: r.kind,
    code: g.rows.find((x) => x.ref === r.ref)?.code ?? null,
    cells: r.cells.map((c) => ({ tier: c.tier, source: c.source, value: c.value })),
  }));
}
