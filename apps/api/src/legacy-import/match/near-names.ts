import { normalizeItemName } from "./normalize-item-name";
import type { CatalogItemRow, ItemSuggestion, NearNameGroup } from "./types";

/** Dice score at or above which two names are called near. */
export const NEAR_NAME_THRESHOLD = 0.8;

interface Parts {
  parent: string;
  child: string;
  numbers: string;
  compact: string;
}

function parts(name: string): Parts {
  const normalised = normalizeItemName(name);
  const cut = normalised.lastIndexOf(":");
  const parent = cut === -1 ? "" : normalised.slice(0, cut);
  const child = cut === -1 ? normalised : normalised.slice(cut + 1);
  const numbers = (normalised.match(/\p{N}+/gu) ?? []).join(",");
  return { parent, child, numbers, compact: child.replace(/\s+/g, "") };
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * 0..1 nearness of two item names. Two hard gates keep a size or a branch from being folded:
 * the numbers in the name must be the same, and when both names carry a parent the parents
 * must match. Failing a gate scores 0.
 */
/** Both hard gates: the same numbers in the same order, and the same parent when both have one. */
export function gatesPass(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  if (pa.numbers !== pb.numbers) return false;
  return !(pa.parent !== "" && pb.parent !== "" && pa.parent !== pb.parent);
}

export function nearNameScore(a: string, b: string): number {
  if (!gatesPass(a, b)) return 0;
  return dice(parts(a).compact, parts(b).compact);
}

/** Plain code-point order: never the machine's locale. */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups of two or more near source names. A suggestion only: `confirmed` is always false. */
export function groupNearNames(names: string[]): NearNameGroup[] {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))].sort(
    compareCodePoint,
  );
  const root = unique.map((_, i) => i);
  const find = (i: number): number => {
    while (root[i] !== i) {
      root[i] = root[root[i]];
      i = root[i];
    }
    return i;
  };
  const inGroup = (r: number): string[] => unique.filter((_, k) => find(k) === r);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      if (find(i) === find(j)) continue;
      if (nearNameScore(unique[i], unique[j]) < NEAR_NAME_THRESHOLD) continue;
      // Every cross pair must pass both gates, so a parentless name cannot bridge two parents.
      const left = inGroup(find(i));
      const right = inGroup(find(j));
      if (left.every((x) => right.every((y) => gatesPass(x, y)))) root[find(j)] = find(i);
    }
  }
  const byRoot = new Map<number, string[]>();
  unique.forEach((n, i) => {
    const r = find(i);
    byRoot.set(r, [...(byRoot.get(r) ?? []), n]);
  });
  return [...byRoot.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({ members, confirmed: false as const }))
    .sort((x, y) => compareCodePoint(x.members[0], y.members[0]));
}

/** Nearest catalog rows for a source name, best first. Never confirms a match. */
export function suggestNearNames(
  name: string,
  catalog: CatalogItemRow[],
  limit = 5,
): ItemSuggestion[] {
  return catalog
    .map((row) => ({ productId: row.id, name: row.name, score: nearNameScore(name, row.name) }))
    .filter((s) => s.score >= NEAR_NAME_THRESHOLD)
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareCodePoint(a.name, b.name) ||
        compareCodePoint(a.productId, b.productId),
    )
    .slice(0, Math.max(0, limit));
}
