import {
  buildPOLine,
  derivedCaseCost,
  normalizeBoxesPieces,
  roundUnitCost,
} from "@routeflow/pricing";
import type { UpdatePurchaseOrderItemInput } from "@/lib/api/inventory";
import {
  resolvePOLine,
  resolvePOLineAmounts,
  type POItem,
  type POLineItem,
  type PurchaseOrder,
  linePack,
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
export function toEditLine(item: POItem, livePack: number): EditLine {
  const unitsPerBox = linePack(item, livePack); // B699: the line's own stored pack wins
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
      // the case cost derived from the stored EXACT total when there is one (a new row of 1,000 cases at
      // $11,000.00 reads back 11), else honestly from the per-piece cost at 4 dp: an OLD drifted row (0.9167 a
      // piece, total 11,000.40) reads back 11.0004, never masked; the operator re-enters 11.00 (reading
      // never rewrites a row)
      unitCost: String(
        derivedCaseCost(cost, unitsPerBox, {
          totalCost: item.totalCost != null ? Number(item.totalCost) : null,
          qtyOrdered: ordered,
        }),
      ),
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
    const { qty, unitCost } = resolvePOLine(l, linePack(l, unitsPerBoxFor(l.productId)));
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

/**
 * The PATCH `items` array. A boxed line goes as the ENTERED case figures (packSize, caseCost, cases,
 * loosePieces): the server computes quantity, per-piece cost and the exact total and ignores any client figure.
 * A per-piece line goes as pieces and a per-piece cost. Existing lines keep their id / sku (and pack size).
 */
export function buildUpdateItems(
  lines: EditLine[],
  unitsPerBoxFor: (productId: string) => number,
): UpdatePurchaseOrderItemInput[] {
  return lines
    .filter((l) => l.productId || l.id)
    .map((l) => {
      const upb = linePack(l, unitsPerBoxFor(l.productId)); // B699: stored pack wins
      if (upb > 1) {
        const a = resolvePOLineAmounts(l, upb);
        return {
          ...(l.id ? { id: l.id } : {}),
          productId: l.productId,
          packSize: upb,
          // Decimal(10,4) at most, as the DTO enforces
          caseCost: roundUnitCost(a.caseCost ?? 0),
          cases: a.cases ?? 0,
          loosePieces: a.loosePieces ?? 0,
          ...(l.id ? { sku: l.sku ?? null } : {}),
        };
      }
      const { qty, unitCost } = resolvePOLine(l, upb);
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

/** What an update item stores: quantity, per-piece cost and the exact line total (null if it is unusable). */
function amountsOf(it: UpdatePurchaseOrderItemInput) {
  try {
    return it.caseCost !== undefined
      ? buildPOLine({
          packSize: it.packSize ?? 0,
          caseCost: it.caseCost,
          cases: it.cases ?? 0,
          loosePieces: it.loosePieces ?? 0,
        })
      : buildPOLine({ qtyOrdered: it.qtyOrdered ?? 0, unitCost: it.unitCost ?? 0 });
  } catch {
    return null;
  }
}

/**
 * Did the operator actually change the lines (vs. only the header)? Tolerant of decimal round-trips. The line
 * TOTAL is compared too: re-entering the case cost 11.0004 as 11.00 changes the total (11,000.40 to 11,000.00)
 * with the same quantity and the same 4 dp per-piece cost, so quantity and cost alone would miss it.
 */
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
    const now = amountsOf(it);
    if (!now) return true;
    if (Math.abs(Number(was.qtyOrdered) - now.qtyOrdered) > 0.0005) return true;
    if (Math.abs(Number(was.unitCost) - now.unitCost) > 0.00005) return true;
    if (was.totalCost != null && Math.abs(Number(was.totalCost) - now.totalCost) > 0.005)
      return true;
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
