import {
  applyCellPatches,
  planCellEdit,
  priceGrid,
  type CellChange,
  type CellPatch,
  type LadderView,
  type Pin,
  type PriceTier,
  type PricePlan,
  type TierRules,
} from "@routeflow/pricing";
import type { CustomerPriceMove } from "@routeflow/types";

export type DraftEntry =
  | { kind: "cell"; key: string; text: string }
  /** A Change prices plan folded in; `key` ("plan:n") lets it be the open plan. */
  | { kind: "plan"; key: string; plan: PricePlan };

export interface CellProblem {
  ref: string;
  tier: PriceTier;
  message: string;
}

export interface FoldResult {
  /** The ladder after every entry and tick, before Keeps. */
  base: LadderView;
  /** The ladder after Keeps as well. */
  view: LadderView;
  patches: CellPatch[];
  problems: CellProblem[];
  plans: Map<string, PricePlan>;
  open: PricePlan | null;
  customerMoves: CustomerPriceMove[];
}

export const cellKey = (ref: string, tier: number) => `${ref}|${tier}`;
export const parseKey = (k: string) => {
  const i = k.lastIndexOf("|");
  return { ref: k.slice(0, i), tier: Number(k.slice(i + 1)) as PriceTier };
};

/** Replays the draft over the served ladder; every price consequence is the pricing package's. */
export function foldDraft(
  from: LadderView,
  rules: TierRules,
  entries: readonly DraftEntry[],
  openKey: string | null,
  ticks: readonly boolean[],
  keeps: readonly Pin[],
  tierName?: (t: PriceTier) => string,
): FoldResult {
  let view = from;
  const patchByCell = new Map<string, CellPatch>();
  const problems: CellProblem[] = [];
  const plans = new Map<string, PricePlan>();
  const fold = (patches: readonly CellPatch[]) => {
    view = applyCellPatches(view, patches).view;
    for (const p of patches) patchByCell.set(cellKey(p.ref, p.tier), p);
  };
  for (const e of entries) {
    if (e.kind === "plan") {
      fold(e.plan.patches);
      plans.set(e.key, e.plan);
      continue;
    }
    const { ref, tier } = parseKey(e.key);
    const p = planCellEdit(view, ref, tier, e.text, rules, tierName);
    plans.set(e.key, p);
    if (p.problems.length > 0)
      problems.push(...p.problems.map((message) => ({ ref, tier, message })));
    else fold(p.patches);
  }
  const open = openKey ? (plans.get(openKey) ?? null) : null;
  const customerMoves: CustomerPriceMove[] = [];
  open?.offers.forEach((o, i) => {
    if (!ticks[i]) return;
    if (o.kind === "tier") fold(o.patches);
    else customerMoves.push(...o.moves);
  });
  const base = view;
  const free = keeps.filter((k) => !patchByCell.has(cellKey(k.ref, k.tier)));
  view = applyCellPatches(
    view,
    free.map((k) => ({ ref: k.ref, tier: k.tier, to: k.value })),
  ).view;
  const was = (p: CellPatch) => from.rows.find((r) => r.ref === p.ref)?.set[p.tier - 1] ?? null;
  const patches = [...patchByCell.values()].filter((p) => was(p) !== p.to);
  return { base, view, patches, problems, plans, open, customerMoves };
}

/** Every price that differs once `patches` are applied to `view`: what an undo would change. */
export function changesFrom(
  view: LadderView,
  rules: TierRules,
  patches: readonly CellPatch[],
): CellChange[] {
  const before = priceGrid(view, rules);
  const changes: CellChange[] = [];
  priceGrid(applyCellPatches(view, patches).view, rules).forEach((row, i) =>
    row.cells.forEach((c, j) => {
      const from = before[i].cells[j].value;
      if (from !== c.value)
        changes.push({ ref: row.ref, label: row.label, tier: c.tier, from, to: c.value });
    }),
  );
  return changes;
}
