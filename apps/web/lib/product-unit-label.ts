import { unitWords } from "@routeflow/pricing";

/** The word a price is quoted per: the unit the operator chose (lower-cased), else "unit". */
export function priceUnitWord(unit: string | null | undefined): string {
  const t = (unit ?? "").trim().toLowerCase();
  return t || "unit";
}

const PACKISH = new Set(["box", "case", "carton", "pack", "crate", "bundle"]);

/** True when the selling unit is a pack, so "Units per {pack}" belongs next to the price. */
export function isPackUnit(unit: string | null | undefined, packLabel?: string | null): boolean {
  const t = priceUnitWord(unit);
  if (t === "unit") return false;
  const w = unitWords({ packLabel });
  return PACKISH.has(t) || t === w.pack.lower || t === w.pack.lowerOther;
}
