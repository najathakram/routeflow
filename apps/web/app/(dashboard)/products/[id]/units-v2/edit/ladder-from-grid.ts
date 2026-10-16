import {
  planCellEdit,
  planOrderUnitSwitch,
  type CellPatch,
  type LadderView,
  type PricePlan,
  type PriceTier,
  type SwitchPlan,
} from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";

/** The grid DTO as the pricing package's LadderView: a positive Set cell is Set, anything else Auto. */
export function ladderViewFromGrid(g: ProductPriceGridDto): LadderView {
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
  return { rows, anchor: g.anchor, tierAnchors: {} };
}

export interface CellEdit {
  ref: string;
  tier: PriceTier;
  text: string;
}

export interface GridEditPlan {
  patches: CellPatch[];
  problems: string[];
  /** One PricePlan per accepted cell edit, in order: what the "also update" panel renders. */
  plans: PricePlan[];
  /** The ladder after the cell edits. */
  view: LadderView;
  /** The order-unit switch on top of the edited ladder, or null. */
  sw: SwitchPlan | null;
}

/** Every price consequence of the draft comes from the pricing package; this only chains the calls. */
export function planGridEdit(
  base: LadderView,
  edits: readonly CellEdit[],
  switchTo: string | null,
  keeps: readonly { ref: string; tier: PriceTier }[],
  tierName?: (t: PriceTier) => string,
): GridEditPlan {
  let view = base;
  const patches: CellPatch[] = [];
  const problems: string[] = [];
  const plans: PricePlan[] = [];
  for (const e of edits) {
    const p = planCellEdit(view, e.ref, e.tier, e.text, undefined, tierName);
    if (p.problems.length > 0) {
      problems.push(...p.problems);
      continue;
    }
    patches.push(...p.patches);
    plans.push(p);
    view = p.view;
  }
  let sw: SwitchPlan | null = null;
  if (switchTo && switchTo !== view.anchor && view.rows.some((r) => r.ref === switchTo)) {
    sw = planOrderUnitSwitch(view, { kind: "product" }, switchTo, { keep: keeps });
  }
  return { patches, problems, plans, view, sw };
}
