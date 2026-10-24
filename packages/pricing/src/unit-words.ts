/**
 * U-3a: the ONE place operator-facing unit words come from. Pure copy, no money.
 *
 * A product's pack ("Box") and loose item ("Piece") may carry a tenant-chosen label; with no label
 * (null / blank / whitespace) every word is the VU-1 default, so a screen that asks this helper
 * prints exactly what the hard-coded VU-1 literal printed. The `unit` input is accepted for the
 * later TenantUnit wiring but deliberately does NOT change any word yet.
 */

export const DEFAULT_PACK_LABEL = "Box";
export const DEFAULT_BASE_LABEL = "Piece";
const DEFAULT_BASE_SHORT = { one: "pc", other: "pcs" } as const;

/** Labels that read the same in the singular and plural ("2 Dozen", "3 kg"). */
const INVARIANT = new Set([
  "dozen",
  "gross",
  "kg",
  "g",
  "lb",
  "oz",
  "l",
  "ml",
  "ft",
  "m",
  "cm",
  "mm",
]);

/** The plural form of a label. Rules in order; a label that is already plural stays as is. */
export function pluralize(label: string): string {
  const w = label.trim();
  if (!w) return w;
  const lc = w.toLowerCase();
  if (lc.endsWith("s") || INVARIANT.has(lc)) return w;
  if (/(ch|sh|x|z)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}

/** `label` for exactly one, its plural for any other count (0 included). */
export function plural(label: string, n: number): string {
  return n === 1 ? label.trim() : pluralize(label);
}

/**
 * A label for the narrow sell-by pill: up to 12 characters show whole, a longer one shows its first
 * 11 plus "." (the full word belongs in the control's aria-label / title).
 */
export function pillLabel(label: string, max = 12): string {
  const t = label.trim();
  return t.length > max ? `${t.slice(0, max - 1)}.` : t;
}

export interface UnitWordsInput {
  packLabel?: string | null;
  baseUnitLabel?: string | null;
  /** Reserved for the TenantUnit wiring; ignored in U-3a. */
  unit?: string | null;
}

export interface UnitWord {
  one: string;
  other: string;
  /** Lower-case singular, for mid-sentence use ("the box"). */
  lower: string;
  /** Lower-case plural ("boxes"). */
  lowerOther: string;
}

export interface UnitWords {
  pack: UnitWord;
  base: UnitWord & { short: { one: string; other: string } };
  isDefaultPack: boolean;
  isDefaultBase: boolean;
  /** Lower-case pack word agreeing with `n` ("box" for 1, else "boxes"). */
  packFor: (n: number) => string;
  /** Lower-case base word agreeing with `n` ("piece" / "pieces"). */
  baseFor: (n: number) => string;
  /** Count-sized base word: "pc"/"pcs" for the default base, the full lower-case word otherwise. */
  baseShortFor: (n: number) => string;
}

function word(label: string): UnitWord {
  const other = pluralize(label);
  return { one: label, other, lower: label.toLowerCase(), lowerOther: other.toLowerCase() };
}

function resolve(
  raw: string | null | undefined,
  fallback: string,
): { label: string; isDefault: boolean } {
  const t = (raw ?? "").trim();
  if (!t || t.toLowerCase() === fallback.toLowerCase()) return { label: fallback, isDefault: true };
  return { label: t, isDefault: false };
}

export function unitWords(p: UnitWordsInput = {}): UnitWords {
  const pk = resolve(p.packLabel, DEFAULT_PACK_LABEL);
  const bs = resolve(p.baseUnitLabel, DEFAULT_BASE_LABEL);
  const pack = word(pk.label);
  const baseW = word(bs.label);
  const short = bs.isDefault
    ? { ...DEFAULT_BASE_SHORT }
    : { one: baseW.lower, other: baseW.lowerOther };
  return {
    pack,
    base: { ...baseW, short },
    isDefaultPack: pk.isDefault,
    isDefaultBase: bs.isDefault,
    packFor: (n) => (n === 1 ? pack.lower : pack.lowerOther),
    baseFor: (n) => (n === 1 ? baseW.lower : baseW.lowerOther),
    baseShortFor: (n) =>
      bs.isDefault ? (n === 1 ? "pc" : "pcs") : n === 1 ? baseW.lower : baseW.lowerOther,
  };
}
