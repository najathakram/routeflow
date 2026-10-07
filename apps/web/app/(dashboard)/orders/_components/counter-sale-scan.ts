import {
  getTierPrice,
  isSpecialTier,
  normalizeBoxesPieces,
  type SellLevel,
} from "@routeflow/pricing";
import { displayProductName } from "@/lib/product-display";
import { mergePieceIntoLine, mergeQtyIntoLine, newLineQtyForLevel } from "./add-line-merge";

/**
 * Pure line logic of the counter-sale till (B1208): what a scan lands on the cart, and the box/piece stepper.
 * Mirrors Create Order: the LEVEL of the scanned code decides the line (a UNIT code on a case-packed product is one
 * loose piece, never a hidden case); money is never derived here (the screen prices through cartTotals, which goes
 * through @routeflow/pricing's computeLineSubtotal).
 */
export interface SaleLine {
  tempId: string;
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  /**
   * B1210: the product snapshot taken when the line was added, so "Ship this order instead" can park the line without a
   * second lookup. `unitPrice` is the TIER price the clerk saw; `listPrice` is the catalogue price. Absent on a line held
   * before this existed (the hand-off falls back to `unitPrice` / "each" / STANDARD).
   */
  listPrice?: number;
  unit?: string;
  priceType?: "STANDARD" | "SPECIAL";
  category?: string;
}

/**
 * Adds `n` of the scanned product. A repeat merges (a UNIT scan on a boxed product adds loose pieces, rolled into
 * boxes; anything else adds whole selling units); a new line starts at the level the code carried.
 */
export function addScannedProduct(
  prev: SaleLine[],
  product: any,
  level: SellLevel,
  n: number,
  tier: number,
): SaleLine[] {
  const upb = product.unitsPerBox ? Number(product.unitsPerBox) : undefined;
  const unitScan = level === "UNIT" && (upb ?? 0) > 1;
  const idx = prev.findIndex((l) => l.productId === product.id);
  if (idx >= 0) {
    return prev.map((l, i) =>
      i === idx ? (unitScan ? mergePieceIntoLine(l, n) : mergeQtyIntoLine(l, n)) : l,
    );
  }
  // A UNIT multiplier at or over the pack size (x30 on a 24-pack) rolls into boxes: 1 box + 6 pcs, never 0 boxes + 30 pcs.
  const born = newLineQtyForLevel(upb, level, n);
  const qty = unitScan && upb ? normalizeBoxesPieces({ qty: born.qty, unitsPerBox: upb }) : null;
  return [
    ...prev,
    {
      tempId: `${product.id}-${prev.length}`,
      productId: product.id,
      name: displayProductName(product),
      unitPrice: getTierPrice(product, tier),
      unitsPerBox: upb,
      listPrice: Number(product.pricePerUnit ?? 0),
      unit: product.unit ?? "each",
      priceType: isSpecialTier(tier) ? "SPECIAL" : "STANDARD",
      ...(product.category ? { category: String(product.category) } : {}),
      ...(qty ? { qty: qty.qty, boxes: qty.boxes ?? 0, pieces: qty.pieces ?? 0 } : born),
    },
  ];
}

export type StepUnit = "box" | "piece";

/**
 * The till stepper. A boxed line (unitsPerBox > 1) steps by a whole box or one loose piece and re-splits through
 * `normalizeBoxesPieces` (24 pieces roll into a box; a box step down never goes below one piece in total). A plain
 * line steps its quantity. A step that would leave nothing returns the SAME line (the x button removes a line).
 */
export function stepLine(l: SaleLine, unit: StepUnit, dir: 1 | -1): SaleLine {
  const upb = l.unitsPerBox ?? 0;
  if (upb > 1) {
    const total = (l.boxes ?? 0) * upb + (l.pieces ?? 0) + dir * (unit === "box" ? upb : 1);
    if (total < 1) return l;
    const norm = normalizeBoxesPieces({ qty: total, unitsPerBox: upb });
    return { ...l, boxes: norm.boxes ?? 0, pieces: norm.pieces ?? 0, qty: norm.qty };
  }
  const next = mergeQtyIntoLine(l, dir);
  return next.qty < 1 ? l : next;
}
