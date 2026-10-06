import { normalizeBoxesPieces } from "@routeflow/pricing";
import type { OrderItemDto } from "../dto/create-order.dto";
import type { CounterSaleDto } from "./counter-sale.dto";

/**
 * One counter-sale line, shaped like the writer will store it (L-226). The DTO makes `qty` optional (a boxed
 * line arrives as boxes/pieces), but create()'s Idempotency-Key replay compares the incoming cart with the
 * stored one by `qty`: a line with none keyed as NaN, never matched, and the resulting 409 pushed the clerk
 * onto a new key (a double sale). So `qty` is ALWAYS set here, to the integer piece count create() stores —
 * through the same `normalizeBoxesPieces` and the same "a zero split is not box entry" rule — and boxes/pieces
 * are passed on unchanged for the writer's own split.
 */
export function toCounterOrderItem(i: CounterSaleDto["items"][number], unitsPerBox: number | null) {
  const boxEntry = (i.boxes ?? 0) > 0 || (i.pieces ?? 0) > 0;
  const qty = boxEntry
    ? normalizeBoxesPieces({
        boxes: i.boxes,
        pieces: i.pieces,
        qty: i.qty,
        unitsPerBox: unitsPerBox ?? 0,
      }).qty
    : i.qty;
  return {
    productId: i.productId,
    ...(qty != null ? { qty } : {}),
    ...(i.boxes != null ? { boxes: i.boxes } : {}),
    ...(i.pieces != null ? { pieces: i.pieces } : {}),
    ...(i.unitPrice != null ? { unitPrice: i.unitPrice } : {}),
    ...(i.priceReason ? { overrideReason: i.priceReason } : {}),
  } as OrderItemDto;
}
