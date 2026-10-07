/**
 * Packing-slip page data (#3168). Pure: one page per carrier order, from what is physically packed —
 * the non-cancelled lines with their quantity in the line's own display unit — and NO money anywhere
 * (a packing slip travels in the parcel; prices stay on the invoice). The PDF template only lays this
 * out, so the decisions are unit-testable (the template is mocked under Jest, like the invoice one).
 */
import { invoiceLineQtyText } from "@routeflow/pricing";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { carrierLabel } from "../common/shipping";
import type { BatchShipOutcome } from "./order-batch-ship";
import { LIVE_BACKORDER_ORDER_STATUSES } from "./backorder-marker";

export interface PackingSlipSeller {
  businessName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  logoDataUri?: string;
}

export interface PackingSlipOrderLike {
  id: string;
  orderNumber: string | null;
  status: OrderStatus;
  fulfillPath: FulfillPath;
  shippingCarrier: string | null;
  shippingTrackingNumber: string | null;
  customer: {
    businessName: string;
    contactName: string;
    addresses: {
      line1: string;
      line2?: string | null;
      city: string;
      state: string;
      zip: string;
      isDefault?: boolean;
      addressType?: string | null;
    }[];
  };
  items: {
    name: string | null;
    qty: unknown;
    boxes: number | null;
    pieces: number | null;
    unitLabel: string | null;
    status: string;
    /** SA-714 R1: pieces sold past stock; > 0 prints the "Backorder" tag. Display only. */
    backorderedPieces?: unknown;
    product?: { name?: string | null; sku?: string | null; unitSku?: string | null } | null;
  }[];
}

export interface PackingSlipLine {
  name: string;
  sku: string | null;
  qtyText: string;
  backordered: boolean;
}

/** The OrderItem columns a slip line reads (one const so a DB spec can run the exact select). */
export const PACKING_SLIP_LINE_SELECT = {
  name: true,
  qty: true,
  boxes: true,
  pieces: true,
  unitLabel: true,
  status: true,
  backorderedPieces: true, // SA-714 R1: the "Backorder" tag (display only)
  product: { select: { name: true, sku: true, unitSku: true } },
} as const;

export interface PackingSlipPage {
  orderId: string;
  orderNumber: string;
  seller: PackingSlipSeller;
  shipTo: string[];
  carrier: string | null;
  trackingNumber: string | null;
  lines: PackingSlipLine[];
}

/** Why an order gets no slip, or null. Only carrier orders have slips; a cancelled order has nothing to pack. */
export function classifyForSlip(o: {
  status: OrderStatus;
  fulfillPath: FulfillPath;
}): BatchShipOutcome | null {
  if (o.fulfillPath !== FulfillPath.SHIP) return "NOT_CARRIER_ORDER";
  if (o.status === OrderStatus.CANCELLED) return "NOT_CONFIRMED";
  return null;
}

const num = (v: unknown): number =>
  typeof v === "number"
    ? v
    : typeof v === "string"
      ? parseFloat(v)
      : ((v as { toNumber?: () => number })?.toNumber?.() ?? 0);

export function buildPackingSlipPages(
  orders: PackingSlipOrderLike[],
  seller: PackingSlipSeller,
  /**
   * SA-716 M1: the slip goes to the customer, so the "Backorder" tag is OFF until PR2's visibility policy
   * (`orders.buyerBackorderVisibility`) is on master and the caller passes it. Even then it follows the
   * live-order rule (never on a DELIVERED, DRAFT or CANCELLED order or a cancelled line).
   */
  opts: { showBackorder?: boolean } = {},
): PackingSlipPage[] {
  return orders.map((o) => {
    // Ship-to: the customer's SHIPPING/DELIVERY address first (a billing default must not win), then
    // the default, then the first one.
    const isShipping = (a: { addressType?: string | null }) =>
      ["SHIPPING", "DELIVERY"].includes((a.addressType ?? "").trim().toUpperCase());
    const addr = [...o.customer.addresses].sort(
      (a, b) =>
        Number(isShipping(b)) - Number(isShipping(a)) ||
        Number(!!b.isDefault) - Number(!!a.isDefault),
    )[0];
    const shipTo = [
      o.customer.businessName,
      o.customer.contactName,
      addr?.line1,
      addr?.line2,
      addr
        ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
        : null,
    ].filter((s): s is string => !!s && s.trim() !== "");
    return {
      orderId: o.id,
      orderNumber: o.orderNumber ?? "",
      seller,
      shipTo,
      carrier: o.shippingCarrier ? carrierLabel(o.shippingCarrier) || o.shippingCarrier : null,
      trackingNumber: o.shippingTrackingNumber?.trim() || null,
      lines: o.items
        .filter((i) => i.status !== "CANCELLED")
        .map((i) => ({
          name: i.name ?? i.product?.name ?? "Item",
          sku: i.product?.unitSku ?? i.product?.sku ?? null,
          qtyText: invoiceLineQtyText({
            qty: num(i.qty),
            boxes: i.boxes,
            pieces: i.pieces,
            unitLabel: i.unitLabel,
          }),
          backordered:
            opts.showBackorder === true &&
            LIVE_BACKORDER_ORDER_STATUSES.has(o.status) &&
            i.status !== "CANCELLED" &&
            num(i.backorderedPieces) > 0,
        })),
    };
  });
}
