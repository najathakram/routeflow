import {
  applyCellPatches,
  planCellEdit,
  priceGrid,
  type CellChange,
  type CellPatch,
  type CustomerPricingWithId,
  type LadderView,
  type Pin,
  type PriceTier,
  type PriceChangeOptions,
  type PricePlan,
  type TierRules,
} from "@routeflow/pricing";
import type { CustomerPriceMove } from "@routeflow/types";

export type DraftEntry =
  | { kind: "cell"; key: string; text: string }
  /**
   * A Change prices plan folded in; `key` ("plan:n") lets it be the open plan. `replan` works the same change out again
   * for the customers as they are now: only the customer half of the plan is taken from it, the applied patches stay.
   */
  | {
      kind: "plan";
      key: string;
      plan: PricePlan;
      replan: (customers: readonly CustomerPricingWithId[]) => PricePlan;
    }
  /**
   * A TICKED offer, baked into the draft at tick time (`id` = "<plan key>#<offer index>"), so a later edit that
   * opens another plan keeps it. Tier offers carry patches, customer offers carry moves; untick removes the entry.
   */
  | {
      kind: "offer";
      id: string;
      planKey: string;
      title: string;
      patches: readonly CellPatch[];
      moves: readonly CustomerPriceMove[];
    };

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
  /** Draft-wide refusals that belong to no cell (two ticked offers moving the same customer price). */
  conflicts: string[];
  /** Titles of the ticked offers baked into the draft, for the save bar. */
  bakedTitles: string[];
}

/** The applied plan with its customer half (the customer offer and the customer changes) from a fresh re-plan. */
const withFreshCustomers = (applied: PricePlan, fresh: PricePlan): PricePlan => ({
  ...applied,
  offers: [
    ...applied.offers.filter((o) => o.kind !== "customer"),
    ...fresh.offers.filter((o) => o.kind === "customer"),
  ],
  customerChanges: fresh.customerChanges,
});

/**
 * One customer move for comparing. A move carries no order unit: a customer whose order unit changed shows up in
 * `to` (the move is worked out from the unit it is anchored on) or in which moves exist at all.
 */
const moveKey = (m: CustomerPriceMove) => [m.customerId, m.ref, m.tier, m.from, m.to].join("|");

/** True when both lists hold exactly the same moves (customer, unit, tier, from, to), in any order. */
export const sameMoves = (a: readonly CustomerPriceMove[], b: readonly CustomerPriceMove[]) =>
  a.length === b.length &&
  [...a].map(moveKey).sort().join(";") === [...b].map(moveKey).sort().join(";");

/**
 * The ticked customer offers that are no longer what a fresh plan of the same offer offers. Compares the FULL move
 * set; a plan that is not there (or has no customer offer left) cannot vouch for the offer, so it is stale too.
 */
export function staleOfferEntries(
  entries: readonly DraftEntry[],
  plans: ReadonlyMap<string, PricePlan>,
): DraftEntry[] {
  return entries.filter((e) => {
    if (e.kind !== "offer" || e.moves.length === 0) return false;
    const fresh = plans.get(e.planKey)?.offers.find((o) => o.kind === "customer");
    return !sameMoves(e.moves, fresh?.kind === "customer" ? fresh.moves : []);
  });
}

/**
 * The customer Keeps the panel no longer shows. A Keep pins a derived customer price (a row of a plan's
 * `customerChanges`) as a set price from nothing, so it holds only while that customer still has no price of their
 * own on the unit AND some plan in the draft still lists that same row (customer, unit, tier) starting from the
 * pinned price. A customer who was deleted or changed tier, or whose derived price moved, fails that.
 */
export function staleKeepMoves(
  moves: readonly CustomerPriceMove[],
  plans: ReadonlyMap<string, PricePlan>,
  customers: readonly CustomerPricingWithId[],
): CustomerPriceMove[] {
  const rows = [...plans.values()].flatMap((p) => p.customerChanges);
  return moves.filter((m) => {
    const own = customers.find((c) => c.customerId === m.customerId)?.set?.[m.ref] ?? null;
    if (own !== m.from) return true;
    return !rows.some(
      (r) =>
        r.customerId === m.customerId && r.ref === m.ref && r.tier === m.tier && r.from === m.to,
    );
  });
}

export const CUSTOMER_MOVE_CONFLICT =
  "These customer prices are already changing in this draft. Save first.";

/** The identity of an offer inside its plan, so a tick does not depend on the offer's index. */
export const offerId = (
  planKey: string,
  o: { kind: "tier"; ref: string; tier: number } | { kind: "customer" },
): string => `${planKey}#${o.kind === "tier" ? `tier:${o.ref}|${o.tier}` : "customer"}`;

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
  keeps: readonly Pin[],
  tierName?: (t: PriceTier) => string,
  customers: PriceChangeOptions["customers"] = [],
): FoldResult {
  let view = from;
  const patchByCell = new Map<string, CellPatch>();
  const problems: CellProblem[] = [];
  const plans = new Map<string, PricePlan>();
  const customerMoves: CustomerPriceMove[] = [];
  const offerMoveCells = new Set<string>();
  const conflicts = new Set<string>();
  const bakedTitles: string[] = [];
  const fold = (patches: readonly CellPatch[]) => {
    view = applyCellPatches(view, patches).view;
    for (const p of patches) patchByCell.set(cellKey(p.ref, p.tier), p);
  };
  // A refused cell is refused only while nothing later writes that cell: a plan or a ticked offer after it wins, so its
  // problem goes with the text (the later value shows, saves and is the only word on the cell).
  const patchOver = (patches: readonly CellPatch[]) => {
    fold(patches);
    const over = new Set(patches.map((p) => cellKey(p.ref, p.tier)));
    for (let i = problems.length - 1; i >= 0; i--)
      if (over.has(cellKey(problems[i].ref, problems[i].tier))) problems.splice(i, 1);
  };
  for (const e of entries) {
    if (e.kind === "plan") {
      patchOver(e.plan.patches);
      plans.set(e.key, withFreshCustomers(e.plan, e.replan(customers)));
      continue;
    }
    if (e.kind === "offer") {
      patchOver(e.patches);
      bakedTitles.push(e.title);
      for (const m of e.moves) {
        // The server's per-cell check passes both moves (they share `from`), so the last would win silently.
        const k = `${m.customerId}|${m.ref}`;
        if (offerMoveCells.has(k)) conflicts.add(CUSTOMER_MOVE_CONFLICT);
        offerMoveCells.add(k);
        customerMoves.push(m);
      }
      continue;
    }
    const { ref, tier } = parseKey(e.key);
    const p = planCellEdit(view, ref, tier, e.text, rules, tierName, { customers });
    plans.set(e.key, p);
    if (p.problems.length > 0)
      problems.push(...p.problems.map((message) => ({ ref, tier, message })));
    else fold(p.patches);
  }
  const open = openKey ? (plans.get(openKey) ?? null) : null;
  const base = view;
  const free = keeps.filter((k) => !patchByCell.has(cellKey(k.ref, k.tier)));
  view = applyCellPatches(
    view,
    free.map((k) => ({ ref: k.ref, tier: k.tier, to: k.value })),
  ).view;
  const was = (p: CellPatch) => from.rows.find((r) => r.ref === p.ref)?.set[p.tier - 1] ?? null;
  const patches = [...patchByCell.values()].filter((p) => was(p) !== p.to);
  return {
    base,
    view,
    patches,
    problems,
    plans,
    open,
    customerMoves,
    conflicts: [...conflicts],
    bakedTitles,
  };
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
