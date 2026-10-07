import type { SellLevel } from "@routeflow/pricing";
import type { PriceType } from "@/lib/api/orders";

export type { SellLevel };
import { scanLevelForHit, scanLevelsForHit } from "../_components/scan/useScanCodeHandler";
export { scanLevelForHit };

/** addProduct's (level, explicit bump level) for a scanned hit. */
export function scanArgsForHit(code: string, p: any): [SellLevel, SellLevel | undefined] {
  return [scanLevelForHit(code, p), explicitBumpLevel(code, p)];
}

/** SA-580c: only a DISTINCT BOX code (levels == [BOX]) is an explicit case scan; shared == tap. */
export function explicitBumpLevel(code: string, product: any): SellLevel | undefined {
  const levels = scanLevelsForHit(code, product);
  return levels.length === 1 && levels[0] === "BOX" ? "BOX" : undefined;
}

// #2717 M4a-1 (SA-580 R1/R4): scan-level line helpers, extracted from page.tsx (size ratchet).

/** A UNIT code on a boxed product (upb > 1) is ONE loose piece; otherwise a case / today's +1. */
export function isUnitScanOnBoxed(p: any, level: SellLevel): boolean {
  return level === "UNIT" && Number(p.unitsPerBox ?? 0) > 1;
}

/**
 * Bump an existing line for a scan. A split line counts PIECES (qty = boxes * upb + pieces); a
 * plain boxed line counts SELLING UNITS (cases). A UNIT scan switches the line to the split form
 * so the loose piece is never hidden; an EXPLICIT scan level BOX on a split line adds a whole case
 * of pieces. `scanLevel` is undefined for a picker TAP, which keeps the old +1 on a split line.
 */
export function bumpLineForScan<
  T extends { qty: number; unitsPerBox?: any; unitLabel?: any; boxSplit?: boolean },
>(it: T, unitScan: boolean, scanLevel?: SellLevel): T {
  const lineUpb = Number(it.unitsPerBox ?? 0);
  const boxedLine = lineUpb > 1 && it.unitLabel == null;
  if (!boxedLine) return { ...it, qty: it.qty + 1 };
  if (unitScan) {
    return it.boxSplit
      ? { ...it, qty: it.qty + 1 }
      : { ...it, qty: it.qty * lineUpb + 1, boxSplit: true };
  }
  return it.boxSplit && scanLevel === "BOX"
    ? { ...it, qty: it.qty + lineUpb }
    : { ...it, qty: it.qty + 1 };
}

/** "1 box + 0 pcs", "2 boxes + 1 pcs" — the count word agrees with its number. */
export function splitLineHintText(qty: number, upb: number): string {
  const boxes = Math.floor(qty / upb);
  return `${boxes} ${boxes === 1 ? "box" : "boxes"} + ${qty % upb} ${qty % upb === 1 ? "pc" : "pcs"}`;
}

/** No hidden quantity (SA-580): a split line counts PIECES, so say boxes + pcs. */
export function SplitLineHint({ item }: { item: any }) {
  const upb = Number(item.unitsPerBox ?? 0);
  if (!(item.boxSplit && upb > 1 && item.unitLabel == null)) return null;
  return (
    <span
      data-testid="edit-line-split"
      className="text-[11px] normal-case tracking-normal text-navy/60"
    >
      pcs = {splitLineHintText(item.qty, upb)}
    </span>
  );
}

/** The new order line the add-product flow appends (moved verbatim out of page.tsx). */
export function buildNewLine(
  p: any,
  o: { newId: string; startPrice: number; base: number; unitScan: boolean; special: boolean },
) {
  const { newId, startPrice, base, unitScan } = o;
  const priceType: PriceType = o.special ? "SPECIAL" : "STANDARD";
  return {
    id: newId,
    isNew: true,
    originalProductId: p.id,
    originalProductName: p.name,
    originalQty: 1,
    productId: p.id,
    productName: p.name,
    qty: 1,
    // A UNIT scan on a boxed product is ONE loose piece: the split form (qty = pieces).
    ...(unitScan ? { boxSplit: true } : {}),
    unitPrice: startPrice,
    basePrice: base,
    originalUnitPrice: startPrice,
    originalBasePrice: base,
    // Carry the case size so a later substitution re-denominates this
    // line's selling-unit qty correctly (boxSplit stays unset for a plain
    // new line — it still bills in selling units and sends no split).
    unitsPerBox: p.unitsPerBox == null ? null : Number(p.unitsPerBox),
    originalUnitsPerBox: p.unitsPerBox == null ? null : Number(p.unitsPerBox),
    cancelled: false,
    // units_v1: OrderLineUnitPicker's required fields (pack unit label + price type).
    unit: p.unit ?? "",
    priceType,
  };
}
