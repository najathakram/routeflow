import {
  computeLineSubtotal,
  formatQtySplit,
  invoiceLineQtyText,
  normalizeBoxesPieces,
} from "@routeflow/pricing";
import { freeUnitsLabel } from "./buyer-cart-logic";
import type { LineComponentView } from "@routeflow/types";
import { lineBackorderPieces } from "@routeflow/types/order-line-backorder";
import { componentSubLineTexts } from "./line-components";
import { restrictionOverrideNoteOf } from "./restriction-override-note";

/**
 * Pure display logic for the operator order-detail line CARD (order-ui-redesign-spec §3, T8 — the
 * React-Native mirror of web's `LineItemRowReadOnly` / `OrderLineItemCards`).
 *
 * RN cannot import the web component, so the row anatomy is one written contract that both apps
 * conform to. The three pure helpers here — `splitProductName`, `displayLineStatus`,
 * `linePriceTag` — are mirrors of their web twins (`apps/web/lib/product-display.ts`,
 * `orders/[id]/_components/line-status.ts`, `apps/web/components/line-price-tag.ts`);
 * `apps/web/lib/order-line-display.parity.test.ts` runs both implementations over the same
 * fixtures so they cannot drift. Display only — never used to derive or store a price.
 */

export const PRODUCT_NAME_SEPARATOR = " - ";

/** Where a row may break a long name: a clampable family `stem` + a never-clamped `anchor`. */
export function splitProductName(name: string): { stem: string | null; anchor: string } {
  const at = name.indexOf(PRODUCT_NAME_SEPARATOR);
  if (at <= 0) return { stem: null, anchor: name };
  const stem = name.slice(0, at).trim();
  const anchor = name.slice(at + PRODUCT_NAME_SEPARATOR.length).trim();
  if (!stem || !anchor) return { stem: null, anchor: name };
  return { stem, anchor };
}

interface ProductLike {
  name: string;
  variantName?: string | null;
  parentProductId?: string | null;
  parent?: { name: string } | null;
}

/** "<Parent> - <Variant>" for a catalog variant (the composed name is never persisted). */
export function displayProductName(product: ProductLike): string {
  if (!product.parentProductId && !product.parent) return product.name;
  const variantPart = (product.variantName ?? product.name).trim();
  if (!variantPart) return product.name;
  const parentName = product.parent?.name ?? null;
  if (!parentName) return variantPart;
  const prefix = `${parentName}${PRODUCT_NAME_SEPARATOR}`;
  if (variantPart.toLowerCase().startsWith(prefix.toLowerCase())) return variantPart;
  return `${parentName}${PRODUCT_NAME_SEPARATOR}${variantPart}`;
}

/** The name to show for an order line on a READ surface; null when neither exists. */
export function orderLineName(line: {
  product?: ProductLike | null;
  name?: string | null;
}): string | null {
  if (line.product) return displayProductName(line.product) || line.name || null;
  return line.name ?? null;
}

/**
 * Displayed fulfilment status for a line. `OrderItem.status` only advances to DELIVERED / PARTIAL
 * via the route delivery flow, so derive the label from delivery data or the order's terminal
 * state — without mutating the stored status.
 */
export function displayLineStatus(
  li: { status: string; deliveredQty?: number | string | null; qty: number | string },
  orderStatus: string,
): string {
  if (li.status === "CANCELLED" || li.status === "DELIVERED" || li.status === "PARTIAL") {
    return li.status;
  }
  const delivered = Number(li.deliveredQty ?? 0);
  if (delivered > 0) return delivered + 1e-6 >= Number(li.qty) ? "DELIVERED" : "PARTIAL";
  if (orderStatus === "DELIVERED") return "DELIVERED";
  return li.status;
}

export interface LinePriceTag {
  label: "Special" | "Upsell" | "Promo" | "Adjusted" | "Discounted";
  tone: "green" | "orange";
  strikeOriginal: boolean;
}

/** Special / Upsell / Discounted / Promo / Adjusted — same branches and order as the web table. */
export function linePriceTag(input: {
  priceType?: string | null;
  originalPrice?: number | string | null;
  unitPrice: number | string;
}): LinePriceTag | null {
  const { priceType } = input;
  const hasOriginal = input.originalPrice != null;
  const original = Number(input.originalPrice);
  const unit = Number(input.unitPrice);
  if (priceType === "SPECIAL")
    return { label: "Special", tone: "green", strikeOriginal: hasOriginal };
  if (priceType === "MANUAL" && hasOriginal && unit > original) {
    return { label: "Upsell", tone: "green", strikeOriginal: false };
  }
  if (
    (priceType === "DISCOUNTED" || priceType === "MANUAL" || priceType === "PROMO") &&
    hasOriginal
  ) {
    const label =
      priceType === "MANUAL" ? "Adjusted" : priceType === "PROMO" ? "Promo" : "Discounted";
    return { label, tone: "orange", strikeOriginal: true };
  }
  return null;
}

function money(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  OUT_FOR_DELIVERY: "Out for delivery",
  PARTIALLY_DELIVERED: "Partially delivered",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  PARTIAL: "Partial",
};

/** "N of M delivered" is only meaningful once the order is out, part-delivered or done. */
const DELIVERY_PROGRESS_STATUSES = new Set([
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
]);

export interface OrderLineCardModel {
  id: string;
  /** Family stem (clamp to 2 lines) — null for a flat name. */
  stem: string | null;
  /** Flavor / pack — never clamped (a flat name is clamped to 3 lines by the view). */
  anchor: string;
  sku: string | null;
  custom: boolean;
  /** "8 × $65.00" / "2 boxes + 3 pcs · $30.00 / box of 12". Never the raw `product.unit`. */
  qtyPriceLine: string;
  tag: (LinePriceTag & { originalText: string | null }) | null;
  freeLabel: string | null;
  note: string | null;
  /** #2717 M3: sub-lines of a composed (mixed-pack) line; the key is absent on a plain line. */
  subLines?: string[];
  /** Formatted line total, or null for a cancelled line (rendered as "—"). */
  total: string | null;
  cancelled: boolean;
  status: { label: string; variant: "green" | "orange" | "red" | "gray" } | null;
  deliveryText: string | null;
  /** SA-714: pieces sold past stock (staff-only, 0 = none/not live); > 0 shows the "Backorder" tag. */
  backorderPieces: number;
  /** One screen-reader sentence for the whole card (see `spokenLine`). */
  spoken: string;
  /**
   * Row 510: "Sold despite restriction · reason · by · when" for a line sold with an override (staff reads only: this
   * model is built on the operator screen from a staff read), else null. Part of the card, not a block between cards.
   */
  overrideNote: string | null;
}

/**
 * The screen-reader sentence for one card: name, quantity · price, price tag, free units, delivery
 * progress, then EITHER the total OR "Cancelled, no charge" — the status pill is spoken only when it
 * is not the cancelled one, so "Cancelled" is never said twice (B597).
 */
export function spokenLine(p: {
  name: string;
  qtyPriceLine: string;
  tagText: string | null;
  freeLabel: string | null;
  deliveryText: string | null;
  status: string | null;
  cancelled: boolean;
  total: string | null;
  backorder?: boolean;
}): string {
  return [
    p.name,
    p.qtyPriceLine,
    p.tagText,
    p.freeLabel,
    p.deliveryText,
    p.backorder ? "backorder" : null,
    p.cancelled ? "Cancelled, no charge" : p.status,
    p.cancelled ? null : p.total ? `total ${p.total}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

interface LineInput {
  id: string;
  productId: string | null;
  name?: string | null;
  product?:
    (ProductLike & { unit?: string; unitsPerBox?: number | null; sku?: string | null }) | null;
  qty: number;
  unitPrice: number;
  originalPrice?: number | null;
  priceType?: string;
  subtotal?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** units_v1: the unit a line is sold by ("Case", "Pallet") — names the box level of a boxed line. */
  unitLabel?: string | null;
  promoFreeUnits?: number | null;
  /** SA-714: pieces sold past stock (a Decimal string over the wire). */
  backorderedPieces?: number | string | null;
  status: string;
  notes?: string | null;
  deliveredQty?: number | null;
  /** #2717 M3: frozen components of a composed (mixed-pack) line. */
  components?: ReadonlyArray<LineComponentView> | null;
  /** Row 510: the staff override stamp, as a staff read carries it (see `restriction-override-note.ts`). */
  restrictionOverrideReason?: string | null;
  restrictionOverrideByName?: string | null;
  restrictionOverrideAt?: string | null;
}

/** Everything the card renders for one order line. Pure — the view only lays it out. */
export function orderLineCardModel(li: LineInput, orderStatus: string): OrderLineCardModel {
  const { stem, anchor } = splitProductName(orderLineName(li) ?? "Custom item");
  const qty = Number(li.qty);
  const unitPrice = Number(li.unitPrice);
  const upb = li.unitsPerBox ?? li.product?.unitsPerBox ?? null;
  const hasSplit = li.boxes != null || li.pieces != null;
  const boxed = hasSplit && !!upb && upb > 1;
  // The box-level noun is the line's own unit when it has one (a 3-Case line reads "3 Cases", not
  // "3 boxes"); `formatQtySplit` does the naming and pluralising — nothing is mirrored here.
  const boxLabel = li.unitLabel?.trim() || null;
  // #2049: a factor-1 units_v1 line (no boxes/pieces split) still carries its own unitLabel
  // ("5 Piece") — route it through the shared formatter instead of a bare "5", the same fix
  // #2046 applied to this screen's other qty cells (B757/#1275) — never a third copy.
  const qtyPriceLine = boxed
    ? `${formatQtySplit({ qty, boxes: li.boxes, pieces: li.pieces, boxLabel })} · ${money(unitPrice)} / ${boxLabel ?? "box"} of ${upb}`
    : hasSplit
      ? `${formatQtySplit({ qty, boxes: li.boxes, pieces: li.pieces, boxLabel })} × ${money(unitPrice)}`
      : // invoiceLineQtyText falls back to formatQtySplit(qty) byte-identical when unitLabel is
        // empty, so this is safe unconditionally — a factor-1 unit line just gains its label.
        `${invoiceLineQtyText({ qty, boxes: li.boxes, pieces: li.pieces, unitLabel: li.unitLabel })} × ${money(unitPrice)}`;

  const cancelled = li.status === "CANCELLED";
  const total =
    li.subtotal != null
      ? Number(li.subtotal)
      : computeLineSubtotal({
          unitPrice,
          qty,
          boxes: li.boxes ?? null,
          pieces: li.pieces ?? null,
          unitsPerBox: upb,
          freeUnits: Math.max(0, Math.trunc(Number(li.promoFreeUnits ?? 0) || 0)),
        });

  const tag = linePriceTag({
    priceType: li.priceType,
    originalPrice: li.originalPrice,
    unitPrice,
  });

  const shown = displayLineStatus(li, orderStatus);
  const status =
    shown === "PENDING"
      ? null
      : {
          label: STATUS_LABELS[shown] ?? shown.toLowerCase(),
          variant:
            shown === "DELIVERED"
              ? ("green" as const)
              : shown === "PARTIAL"
                ? ("orange" as const)
                : shown === "CANCELLED"
                  ? ("red" as const)
                  : ("gray" as const),
        };

  // `qty` and `deliveredQty` are both in PIECES; a boxed line shows its quantity as boxes + pieces,
  // so progress must read in the same units ("0 of 2 boxes + 3 pcs", never "0 of 51") — B597.
  const qtyText = (n: number) =>
    boxed
      ? formatQtySplit({ ...normalizeBoxesPieces({ qty: n, unitsPerBox: upb }), boxLabel })
      : formatQtySplit({ qty: n });
  const delivered = li.deliveredQty == null ? null : Number(li.deliveredQty);
  // B669 (#1702): a CANCELLED line owes nothing — "0 of 8 delivered" beside it reads as a shortfall.
  const deliveryText =
    DELIVERY_PROGRESS_STATUSES.has(orderStatus) &&
    !cancelled &&
    delivered != null &&
    delivered < qty
      ? `${qtyText(delivered)} of ${qtyText(qty)} delivered`
      : null;
  const tagText = tag ? `${tag.label} price` : null;
  const totalText = cancelled ? null : money(total);
  const backorderPieces = lineBackorderPieces(li, orderStatus);
  const spoken = spokenLine({
    backorder: backorderPieces > 0,
    name: stem ? `${stem} ${anchor}` : anchor,
    qtyPriceLine,
    tagText,
    freeLabel: freeUnitsLabel(li.promoFreeUnits),
    deliveryText,
    status: status?.label ?? null,
    cancelled,
    total: totalText,
  });

  return {
    id: li.id,
    stem,
    anchor,
    sku: li.product?.sku ?? null,
    custom: !li.productId,
    backorderPieces,
    qtyPriceLine,
    tag: tag
      ? {
          ...tag,
          originalText:
            tag.strikeOriginal && li.originalPrice != null ? money(li.originalPrice) : null,
        }
      : null,
    freeLabel: freeUnitsLabel(li.promoFreeUnits),
    note: li.notes?.trim() ? li.notes.trim() : null,
    ...(li.components?.length ? { subLines: componentSubLineTexts(li.components) } : {}),
    total: totalText,
    cancelled,
    status,
    deliveryText,
    spoken,
    overrideNote: restrictionOverrideNoteOf(li),
  };
}
