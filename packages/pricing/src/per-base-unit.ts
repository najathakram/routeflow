/**
 * Per-piece price printed beside a pack line (display only; never summed or multiplied back).
 * `round4(unitPrice / unitsPerBox)`; the unit word is the frozen base label, else "pc".
 */
export interface PerBaseUnitLine {
  unitPrice: number | string | null;
  unitsPerBox: number | null;
  productId?: string | null;
  compositionMode?: string | null;
  systemKind?: string | null;
}

export interface PerBaseUnitPrice {
  price: number;
  unit: string;
}

/** The one literal for a base unit with no frozen label. */
export const DEFAULT_BASE_UNIT_WORD = "pc";

const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function perBaseUnitPrice(
  line: PerBaseUnitLine,
  baseUnitLabel: string | null | undefined,
): PerBaseUnitPrice | null {
  const pack = line.unitsPerBox;
  if (pack == null || !Number.isInteger(pack) || pack <= 1) return null;
  if (!line.productId || line.systemKind || line.compositionMode) return null;
  const unitPrice = Number(line.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return null;
  const label = baseUnitLabel?.trim().toLowerCase();
  return { price: round4(unitPrice / pack), unit: label || DEFAULT_BASE_UNIT_WORD };
}

/** A per-piece price: min 2, max 4 decimals, trailing zeros trimmed ("$2.00", "$2.0005"). The ONE price text on the invoice surfaces. */
export function basePriceText(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/** Min 2, max 4 decimals: "$2.00/pc", "$0.125/pc". */
export function formatPerBaseUnitPrice(p: PerBaseUnitPrice): string {
  return `${basePriceText(p.price)}/${p.unit}`;
}

/** The word after "/" on any per-piece text (MSRP notes included); a loose line has no perBaseUnit, so "pc". */
export function baseUnitSuffix(perBaseUnit?: PerBaseUnitPrice | null): string {
  return perBaseUnit?.unit ?? DEFAULT_BASE_UNIT_WORD;
}
