export function getTierPrice(product: any, tier: number): number {
  switch (tier) {
    case 1:
      return Number(product.pricePerUnit ?? 0);
    case 2:
      return Number(product.priceTier2 ?? product.pricePerUnit ?? 0);
    case 3:
      return Number(product.priceTier3 ?? product.pricePerUnit ?? 0);
    case 4:
      return Number(product.priceTier4 ?? product.pricePerUnit ?? 0);
    case 5:
      return Number(product.priceTier5 ?? product.pricePerUnit ?? 0);
    default:
      return Number(product.pricePerUnit ?? 0);
  }
}

/**
 * Web-side mirror of `apps/api/src/common/pricing.ts#computeLineSubtotal`.
 * MUST stay in sync with the server — the server is authoritative on what
 * gets stored, but the client uses this for live "Line total" displays so
 * the operator sees exactly the number the server will compute.
 *
 * For boxed products (`unitsPerBox > 1`) `unitPrice` is the BOX price.
 * Loose pieces below a full box are prorated as `unitPrice / unitsPerBox`.
 * Non-boxed products keep the per-piece semantics unchanged.
 */
export interface LineSubtotalInput {
  unitPrice: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

/**
 * Round a monetary amount to cents — single rounding policy mirrored from
 * `apps/api/src/common/pricing.ts#roundMoney`. Keep all three in sync.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

export interface NormalizedQty {
  boxes: number | null;
  pieces: number | null;
  qty: number;
}

/**
 * Force INTEGER boxes/pieces/qty and roll loose pieces >= unitsPerBox into boxes.
 * Mirror of `apps/api/src/common/pricing.ts#normalizeBoxesPieces`.
 */
export function normalizeBoxesPieces(input: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}): NormalizedQty {
  const upb = Math.trunc(Number(input.unitsPerBox ?? 0));
  if (upb > 1) {
    const splitProvided = input.boxes != null || input.pieces != null;
    const totalPieces = splitProvided
      ? Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0))
      : Math.trunc(Number(input.qty ?? 0));
    const safeTotal = Math.max(0, totalPieces);
    return { boxes: Math.floor(safeTotal / upb), pieces: safeTotal % upb, qty: safeTotal };
  }
  return { boxes: null, pieces: null, qty: Math.max(0, Math.trunc(Number(input.qty ?? 0))) };
}

export function computeLineSubtotal({
  unitPrice,
  qty,
  boxes,
  pieces,
  unitsPerBox,
}: LineSubtotalInput): number {
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = b + p / upb;
    return roundMoney(unitPrice * boxEquivalent);
  }
  return roundMoney(unitPrice * qty);
}
