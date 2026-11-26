import type { CustomerCandidate, RfCustomerRow } from "./types";

/** Score at or above which a name is offered as a suggestion. A suggestion never binds. */
export const NEAR_CUSTOMER_THRESHOLD = 0.6;

/** Score given when every token matches exactly or as an abbreviation of the other name's. */
const ABBREVIATION_SCORE = 0.85;
/** Score given when the names differ only in spacing. */
const SPACING_SCORE = 0.95;

/** Plain code-point order: never the machine's locale. */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparison string only: lowercase, & as and, punctuation to spaces, spaces collapsed. */
export function normalizeCustomerName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** `short` is an abbreviation of `long`: same first letter, in order, and shorter. */
function isAbbreviation(short: string, long: string): boolean {
  if (short.length < 2 || short.length >= long.length || short[0] !== long[0]) return false;
  let at = 0;
  for (const ch of long) if (ch === short[at]) at++;
  return at === short.length;
}

function tokenMatches(a: string, b: string): boolean {
  return a === b || isAbbreviation(a, b) || isAbbreviation(b, a);
}

/**
 * 0..1 nearness of two customer names. A blank name scores 0. The numbers anywhere in the
 * name must be the same, in the same order, or the score is 0 (ACME is never ACME 2). A
 * name that is only part of another (Acme vs Acme Market) is not near: partial names never
 * attach. Only spacing differences, abbreviations token by token, and small typos in names
 * with the same number of words score.
 */
export function customerNameScore(a: string, b: string): number {
  const na = normalizeCustomerName(a);
  const nb = normalizeCustomerName(b);
  if (na === "" || nb === "") return 0;
  if (na === nb) return 1;
  const numbersA = (na.match(/\p{N}+/gu) ?? []).join(",");
  const numbersB = (nb.match(/\p{N}+/gu) ?? []).join(",");
  if (numbersA !== numbersB) return 0;
  const compactA = na.replace(/ /g, "");
  const compactB = nb.replace(/ /g, "");
  if (compactA === compactB) return SPACING_SCORE;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  if (ta.length !== tb.length) return 0;
  if (ta.every((t, i) => tokenMatches(t, tb[i]))) return ABBREVIATION_SCORE;
  return dice(compactA, compactB);
}

/** Nearest RF customers for a name, best first. Never confirms a binding. */
export function suggestCustomers(
  name: string,
  customers: RfCustomerRow[],
  limit = 5,
): CustomerCandidate[] {
  return customers
    .map((c) => ({
      customerId: c.id,
      name: c.name,
      score: customerNameScore(name, c.name),
      basis: "NEAR" as const,
    }))
    .filter((c) => c.score >= NEAR_CUSTOMER_THRESHOLD)
    .sort(
      (x, y) =>
        y.score - x.score ||
        compareCodePoint(x.name, y.name) ||
        compareCodePoint(x.customerId, y.customerId),
    )
    .slice(0, Math.max(0, limit));
}
