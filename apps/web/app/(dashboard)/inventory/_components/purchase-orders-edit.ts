import { normalizeBoxesPieces, roundUnitCost } from "@routeflow/pricing";
import type { UpdatePurchaseOrderItemInput } from "@/lib/api/inventory";
import {
  resolvePOLine,
  type POItem,
  type POLineItem,
  type PurchaseOrder,
} from "./purchase-orders-shared";

/**
 * Pure logic behind the Edit-PO modal (LANE-U step 6, web half) — kept out of the
 * component so the rules that protect stock are unit-testable without rendering.
 *
 * The rules mirror `PATCH /inventory/purchase-orders/:id` (see
 * InventoryService.updatePurchaseOrder): a re-apply restates the COST of what was
 * received, never its quantity, so a received line can never drop below what was
 * received, change product or be removed; extra quantity or a new line is
 * outstanding and is received later through the normal receive.
 */

// UpdatePurchaseOrderDto's bounds (apps/api/src/inventory/dto/update-purchase-order.dto.ts):
// the form mirrors them so a value the API would reject is explained here, not as a 400.
const MAX_LINES = 200;
const MIN_QTY = 0.001;
const MAX_QTY = 9_999_999;
const MAX_COST = 999_999;
/** qtyOrdered is Decimal(10,3) — the DTO refuses more than 3 decimals. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A form line: the create form's line plus what an EXISTING line carries. */
export interface EditLine extends POLineItem {
  /** Present on an existing line; absent on one added in the modal. */
  id?: string;
  /** Pieces already received on this line (0 for a new line). */
  received: number;
  sku?: string | null;
  packSize?: number | null;
}

export const emptyEditLine = (): EditLine => ({
  productId: "",
  qty: "",
  unitCost: "",
  boxes: "",
  pieces: "",
  received: 0,
});

/**
 * A stored line as a form line. Boxed products are shown as Boxes + Pieces and a
 * Cost-per-Box — the same entry the Create form uses — so `resolvePOLine` converts
 * it back to pieces and a per-piece cost on save.
 */
export function toEditLine(item: POItem, unitsPerBox: number): EditLine {
  const ordered = Number(item.qtyOrdered ?? 0);
  const cost = Number(item.unitCost ?? 0);
  const base = {
    id: item.id,
    productId: item.productId,
    received: Number(item.qtyReceived ?? 0),
    sku: item.sku ?? null,
    packSize: item.packSize ?? null,
  };
  if (unitsPerBox > 1) {
    const split = normalizeBoxesPieces({ qty: ordered, unitsPerBox });
    return {
      ...base,
      qty: "",
      boxes: String(split.boxes ?? 0),
      pieces: String(split.pieces ?? 0),
      unitCost: String(roundUnitCost(cost * unitsPerBox)),
    };
  }
  return { ...base, qty: String(ordered), boxes: "", pieces: "", unitCost: String(cost) };
}

/**
 * The first reason this line set can't be saved, or null. Client-side mirror of what
 * the API refuses, so the operator hears it before the round trip.
 */
export function validateEditLines(
  lines: EditLine[],
  unitsPerBoxFor: (productId: string) => number,
): string | null {
  const filled = lines.filter((l) => l.productId || l.id);
  if (filled.length === 0) return "Add at least one line item.";
  if (filled.length > MAX_LINES) return `A purchase order can have at most ${MAX_LINES} lines.`;
  for (const l of filled) {
    if (!l.productId) return "Choose a product for every line.";
    const { qty, unitCost } = resolvePOLine(l, unitsPerBoxFor(l.productId));
    if (!(qty > 0)) return "Every line needs a quantity above zero.";
    if (!(unitCost >= 0)) return "Every line needs a valid cost.";
    if (qty < MIN_QTY) return "Every line needs a quantity of at least 0.001.";
    if (qty > MAX_QTY) return "A line quantity can't be more than 9,999,999.";
    if (unitCost > MAX_COST) return "A line cost can't be more than 999,999.";
    if (l.id && qty < l.received) {
      return (
        `A line can't go below what was already received (${l.received}). ` +
        "A received quantity only comes back out by recording a return."
      );
    }
  }
  return null;
}

/** The PATCH `items` array — pieces and a per-piece cost, existing lines keep their id / sku / pack size. */
export function buildUpdateItems(
  lines: EditLine[],
  unitsPerBoxFor: (productId: string) => number,
): UpdatePurchaseOrderItemInput[] {
  return lines
    .filter((l) => l.productId || l.id)
    .map((l) => {
      const { qty, unitCost } = resolvePOLine(l, unitsPerBoxFor(l.productId));
      return {
        ...(l.id ? { id: l.id } : {}),
        productId: l.productId,
        // 3dp quantity / 4dp per-piece cost — the stored precision the DTO enforces
        qtyOrdered: round3(qty),
        unitCost: roundUnitCost(unitCost),
        ...(l.id ? { sku: l.sku ?? null, packSize: l.packSize ?? null } : {}),
      };
    });
}

/** Did the operator actually change the lines (vs. only the header)? Tolerant of decimal round-trips. */
export function linesChanged(
  po: Pick<PurchaseOrder, "items">,
  items: UpdatePurchaseOrderItemInput[],
): boolean {
  const original = po.items ?? [];
  if (original.length !== items.length) return true;
  const byId = new Map(original.map((i) => [i.id, i]));
  for (const it of items) {
    const was = it.id ? byId.get(it.id) : undefined;
    if (!was) return true;
    if (was.productId !== it.productId) return true;
    if (Math.abs(Number(was.qtyOrdered) - it.qtyOrdered) > 0.0005) return true;
    if (Math.abs(Number(was.unitCost) - it.unitCost) > 0.00005) return true;
  }
  return false;
}

/** A PO whose stock was already touched — edits to its lines need the operator's say on inventory. */
export const isReceived = (po: Pick<PurchaseOrder, "status">) =>
  po.status === "PARTIAL" || po.status === "RECEIVED";

/** Can this PO be edited at all? (CLOSED can't.) */
export const isEditable = (po: Pick<PurchaseOrder, "status">) => po.status !== "CLOSED";

/** Explain the API's refusals in operator terms; null = not one we know, show the server text. */
export function explainEditError(err: unknown): string | null {
  const data = (err as { response?: { data?: { code?: string; message?: string | string[] } } })
    ?.response?.data;
  if (data?.code === "PO_LOT_PARTIALLY_CONSUMED") {
    return (
      "Part of what was received on this purchase order has already been sold or used, so its cost " +
      "can't be restated in stock. Choose “Keep stock as is” to change the document only."
    );
  }
  // A class-validator 400 carries message: string[] — show it as one readable sentence.
  const message = Array.isArray(data?.message) ? data.message.join("; ") : data?.message;
  return message || null;
}
