// Units rebuild P0b — the ladder is a TREE rooted at the base unit. `factorToBase` stays the ONLY
// math source; `perParent` is the count the operator ENTERED ("10 B = 1 C") and must reproduce it
// EXACTLY: factorToBase = perParent x parent.factorToBase. Pure (no DB) — ProductUnitsService runs it
// on every write; a parent edit recomputes descendants in the same transaction.

/** Hard ceiling on any level's factor (matches the DTO `@Max`). */
export const MAX_FACTOR_TO_BASE = 1_000_000;

export interface ChainLevel {
  /** Any stable id (the row id, or a temp key for a row being created). */
  key: string;
  factorToBase: number;
  /** `null`/undefined = a direct child of the base (a sibling of its peers). */
  parentKey?: string | null;
  /** The entered chain count; required whenever `parentKey` is set. */
  perParent?: number | null;
}

export type ChainViolationCode =
  | "FACTOR_INVALID"
  | "PER_PARENT_INVALID"
  | "PARENT_UNKNOWN"
  | "PARENT_NOT_SMALLER"
  | "FACTOR_MISMATCH"
  | "DUPLICATE_FACTOR"
  | "OVER_CAP"
  | "CYCLE";

export interface ChainViolation {
  code: ChainViolationCode;
  key: string;
  message: string;
}

export interface ChainResult {
  ok: boolean;
  violations: ChainViolation[];
}

/** Levels in parent-before-child order; members of a cycle are returned in `cyclic`. */
function topo(levels: readonly ChainLevel[]): { order: ChainLevel[]; cyclic: ChainLevel[] } {
  const byKey = new Map(levels.map((l) => [l.key, l]));
  const order: ChainLevel[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const cyclic = new Set<ChainLevel>();
  const visit = (l: ChainLevel) => {
    if (state.get(l.key) === 2) return;
    if (state.get(l.key) === 1) {
      cyclic.add(l);
      return;
    }
    state.set(l.key, 1);
    const parent = l.parentKey ? byKey.get(l.parentKey) : undefined;
    if (parent) visit(parent);
    state.set(l.key, 2);
    if (!cyclic.has(l)) order.push(l);
  };
  levels.forEach(visit);
  // a cycle member poisons its whole loop: re-walk to mark every member
  for (const l of levels) {
    const seen = new Set<string>();
    let cur: ChainLevel | undefined = l;
    while (cur && cur.parentKey && !seen.has(cur.key)) {
      seen.add(cur.key);
      cur = byKey.get(cur.parentKey);
    }
    if (cur && seen.has(cur.key)) cyclic.add(l);
  }
  return { order: order.filter((l) => !cyclic.has(l)), cyclic: [...cyclic] };
}

/**
 * Recompute every chained level's factor from `perParent x parent.factorToBase` (parents first).
 * Levels with no parent (or no perParent) keep their entered factor. Returns NEW objects; callers
 * persist the ones whose factor changed. A cycle leaves its members untouched (the validator names it).
 */
export function deriveChainFactors<T extends ChainLevel>(levels: readonly T[]): T[] {
  const { order } = topo(levels);
  const factor = new Map<string, number>(levels.map((l) => [l.key, l.factorToBase]));
  for (const l of order) {
    if (l.parentKey && l.perParent != null && factor.has(l.parentKey)) {
      factor.set(l.key, Number(l.perParent) * (factor.get(l.parentKey) as number));
    }
  }
  return levels.map((l) => ({ ...l, factorToBase: factor.get(l.key) as number }));
}

/** Validate the ladder as a tree rooted at the base (the base itself is factor 1 and is not a level here). */
export function validateUnitChain(levels: readonly ChainLevel[]): ChainResult {
  const violations: ChainViolation[] = [];
  const add = (code: ChainViolationCode, key: string, message: string) =>
    violations.push({ code, key, message });
  const byKey = new Map(levels.map((l) => [l.key, l]));

  for (const l of levels) {
    if (!Number.isInteger(l.factorToBase) || l.factorToBase < 1) {
      add("FACTOR_INVALID", l.key, "A unit size must be a whole number of at least 1.");
    }
    if (l.factorToBase > MAX_FACTOR_TO_BASE) {
      add(
        "OVER_CAP",
        l.key,
        `A unit cannot hold more than ${MAX_FACTOR_TO_BASE.toLocaleString("en-US")} base units.`,
      );
    }
    if (l.parentKey) {
      if (!byKey.has(l.parentKey)) {
        add("PARENT_UNKNOWN", l.key, "The parent unit is not part of this product's ladder.");
        continue;
      }
      if (l.perParent == null || !Number.isInteger(l.perParent) || l.perParent < 2) {
        add("PER_PARENT_INVALID", l.key, "A unit holds a whole number (2 or more) of its parent.");
        continue;
      }
      const parent = byKey.get(l.parentKey) as ChainLevel;
      if (parent.factorToBase >= l.factorToBase) {
        add("PARENT_NOT_SMALLER", l.key, "A unit must be larger than its parent.");
      } else if (l.factorToBase !== l.perParent * parent.factorToBase) {
        add(
          "FACTOR_MISMATCH",
          l.key,
          `${l.perParent} x ${parent.factorToBase} is ${l.perParent * parent.factorToBase}, not ${l.factorToBase}.`,
        );
      }
    } else if (l.perParent != null && (!Number.isInteger(l.perParent) || l.perParent < 2)) {
      add("PER_PARENT_INVALID", l.key, "A unit holds a whole number (2 or more) of its parent.");
    }
  }

  const { cyclic } = topo(levels);
  for (const l of cyclic) add("CYCLE", l.key, "Units cannot be each other's parent.");

  const seen = new Map<number, string>();
  for (const l of levels) {
    const other = seen.get(l.factorToBase);
    if (other !== undefined && other !== l.key) {
      add("DUPLICATE_FACTOR", l.key, `Another unit already holds ${l.factorToBase} base units.`);
    } else seen.set(l.factorToBase, l.key);
  }
  return { ok: violations.length === 0, violations };
}
