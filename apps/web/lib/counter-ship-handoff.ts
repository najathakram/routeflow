import type { SaveDraftInput } from "@/lib/api/drafts";
import { draftDeviceLabel, type DraftLineItem, type OrderDraftPayload } from "@/lib/drafts";

/**
 * B1210: "Ship this order instead" on the counter sale. The cart and customer become the order builder's parked-draft
 * payload (the shape `CreateOrderModal` hydrates on `?resumeDraft=<id>`). Pure: money is not re-derived here, every line
 * carries the unit price, boxes and pieces the clerk SAW at the till (the builder prices boxed lines through
 * `@routeflow/pricing`).
 */

export const COUNTER_SHIP_FAILED_COPY = "Couldn't move this sale to shipping. Try again.";
export const COUNTER_SHIP_WALK_IN_CAPTION = "Who are we shipping to? Find a customer.";

/** The slice of a counter `SaleLine` the hand-off reads (structural, so `lib` does not import from `app`). */
export interface CounterShipLine {
  productId: string;
  name: string;
  unitPrice: number;
  qty: number;
  unitsPerBox?: number;
  boxes?: number;
  pieces?: number;
  /** Product snapshot taken when the line was added; lines held before it existed fall back (see the mapper). */
  listPrice?: number;
  unit?: string;
  priceType?: "STANDARD" | "SPECIAL";
  unitCost?: number;
  category?: string;
}

export interface CounterShipCustomer {
  id: string;
  businessName: string;
  pricingTier?: number | null;
}

export type ShipDraftPayload = OrderDraftPayload & { fulfillPath: "SHIP" };

let seq = 0;
/** A tempId that is new on every call (the builder keys its line rows on it; the counter's ids must not leak across). */
function freshTempId(productId: string): string {
  seq += 1;
  return `${productId}-ship-${Date.now().toString(36)}-${seq}`;
}

function toDraftLine(l: CounterShipLine): DraftLineItem {
  const priceType = l.priceType ?? "STANDARD";
  return {
    tempId: freshTempId(l.productId),
    productId: l.productId,
    productName: l.name,
    unit: l.unit ?? "each",
    listPrice: l.listPrice ?? l.unitPrice,
    ...(priceType === "SPECIAL" ? { specialPrice: l.unitPrice } : {}),
    unitPrice: l.unitPrice,
    priceType,
    qty: l.qty,
    ...(l.unitsPerBox != null ? { unitsPerBox: l.unitsPerBox } : {}),
    ...(l.boxes != null ? { boxes: l.boxes } : {}),
    ...(l.pieces != null ? { pieces: l.pieces } : {}),
    ...(l.unitCost != null ? { unitCost: l.unitCost } : {}),
    ...(l.category ? { category: l.category } : {}),
  };
}

export function counterCartToDraftPayload(
  lines: readonly CounterShipLine[],
  customer: CounterShipCustomer,
): ShipDraftPayload {
  return {
    customer: {
      id: customer.id,
      businessName: customer.businessName,
      ...(customer.pricingTier != null ? { pricingTier: customer.pricingTier } : {}),
    },
    lineItems: lines.map(toDraftLine),
    orderDiscount: "",
    shippingFee: "",
    requestedDeliveryDate: "",
    orderDate: "",
    notes: "",
    urgent: false,
    floorAcked: [],
    fulfillPath: "SHIP",
  };
}

/** The POST /drafts body: an ORDER draft titled "Order, <customer>" (the same title the builder gives a parked order). */
export function counterShipDraftInput(
  lines: readonly CounterShipLine[],
  customer: CounterShipCustomer,
): SaveDraftInput {
  return {
    kind: "ORDER",
    customerId: customer.id,
    customerName: customer.businessName,
    title: `Order, ${customer.businessName}`,
    payload: counterCartToDraftPayload(lines, customer) as unknown as Record<string, unknown>,
    device: draftDeviceLabel(),
  };
}
