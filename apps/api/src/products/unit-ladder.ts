/**
 * Units rebuild U-2: the chained -> flat ladder validator.
 *
 * The editor enters a CHAIN ("6 Bottle = 1 Pack", "4 Pack = 1 Case"); storage is FLAT and
 * `factorToBase` is the only math source (Case = 4 x 6 = 24). This pure module turns the chain into the flat
 * factors and refuses every ladder the storage cannot represent. It has no database access, so the service can
 * run it BEFORE taking a connection.
 *
 * The ladder is a TREE, not a line: a level's parent is the base or ANY other level, so non-dividing siblings
 * (Case 50, Inner 12) both sit under the base. The parent is always named by its label.
 */
export const MAX_FACTOR = 1_000_000;

export interface LadderLevelInput {
  label: string;
  perParent: number;
  /** null / undefined / the base's own label = built directly on the base unit. */
  parentLabel?: string | null;
}

export interface FlatLevel {
  label: string;
  perParent: number;
  /** null = built on the base unit. */
  parentLabel: string | null;
  factorToBase: number;
}

export class LadderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly field: "perParent" | "label" | "parent" | "size",
    readonly level?: string,
  ) {
    super(message);
    this.name = "LadderError";
  }
}

const norm = (s: string) => s.trim().toLowerCase();
const plural = (word: string) => `${word}s`;

/** The base unit's name; Piece when unset. */
export function baseWord(baseLabel: string | null | undefined): string {
  return (baseLabel ?? "").trim() || "Piece";
}

export function flattenLadder(
  baseLabel: string | null | undefined,
  levels: readonly LadderLevelInput[],
): FlatLevel[] {
  const base = baseWord(baseLabel);
  const byKey = new Map<string, LadderLevelInput>();
  for (const l of levels) {
    const label = (l.label ?? "").trim();
    if (!label) throw new LadderError("Pick a unit.", 400, "label");
    const key = norm(label);
    if (key === norm(base)) {
      throw new LadderError(`Pick a bigger unit than ${base}.`, 400, "label", label);
    }
    const first = byKey.get(key);
    if (first) {
      throw new LadderError(
        `${first.label.trim()} is already in this ladder. Use each unit once.`,
        400,
        "label",
        label,
      );
    }
    byKey.set(key, l);
  }

  const memo = new Map<string, number>();
  const resolve = (key: string, path: string[]): number => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const l = byKey.get(key) as LadderLevelInput;
    const label = l.label.trim();
    const n = l.perParent;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2) {
      throw new LadderError("Enter a whole number, 2 or more.", 400, "perParent", label);
    }
    const parentRaw = (l.parentLabel ?? "").trim();
    let parentFactor = 1;
    if (parentRaw && norm(parentRaw) !== norm(base)) {
      const pk = norm(parentRaw);
      if (!byKey.has(pk) || path.includes(pk) || pk === key) {
        throw new LadderError(
          `Pick a unit from this ladder to build ${label} on.`,
          400,
          "parent",
          label,
        );
      }
      parentFactor = resolve(pk, [...path, key]);
    }
    const factor = n * parentFactor;
    if (factor > MAX_FACTOR) {
      throw new LadderError(
        `That's more than 1,000,000 ${plural(base)} in one ${label}. Check the numbers.`,
        409,
        "perParent",
        label,
      );
    }
    memo.set(key, factor);
    return factor;
  };

  const out: FlatLevel[] = levels.map((l) => {
    const label = l.label.trim();
    const parentRaw = (l.parentLabel ?? "").trim();
    const onBase = !parentRaw || norm(parentRaw) === norm(base);
    return {
      label,
      perParent: l.perParent,
      parentLabel: onBase ? null : (byKey.get(norm(parentRaw))?.label.trim() ?? parentRaw),
      factorToBase: resolve(norm(label), []),
    };
  });

  const seen = new Map<number, string>();
  for (const l of out) {
    const prior = seen.get(l.factorToBase);
    if (prior !== undefined) {
      throw new LadderError(
        `${prior} and ${l.label} would both hold ${l.factorToBase} ${plural(base)}. Change one.`,
        409,
        "size",
        l.label,
      );
    }
    seen.set(l.factorToBase, l.label);
  }
  return out;
}
