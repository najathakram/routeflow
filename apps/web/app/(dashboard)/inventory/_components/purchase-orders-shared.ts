import { normalizeBoxesPieces, roundUnitCost } from "@routeflow/pricing";

// Shared purchase-order types + pure line helpers, extracted verbatim from
// inventory/page.tsx (LANE-U step 3 prefactor — behaviour identical).

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
}

export type POStatus = "DRAFT" | "SENT" | "PARTIAL" | "RECEIVED" | "CLOSED";

/**
 * A line as `GET /inventory/purchase-orders[/:id]` actually returns it — the raw
 * Prisma `PurchaseOrderItem` row (no controller/serializer mapping exists), so
 * the quantity fields are `qtyOrdered`/`qtyReceived` (never `qty`/`receivedQty`)
 * and the name comes from the included `product` relation, which the LIST
 * endpoint does NOT include. Every Decimal column arrives as a numeric STRING —
 * always `Number()` before arithmetic or `unitsLabel`.
 */
export interface POItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string } | null;
  qtyOrdered: number | string;
  qtyReceived: number | string;
  unitCost: number | string;
  totalCost?: number | string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplier: Supplier;
  status: POStatus;
  items: POItem[];
  total: number;
  expectedDate: string;
  notes?: string;
  createdAt: string;
}

export interface POLineItem {
  productId: string;
  qty: string;
  unitCost: string;
  /** Whole boxes/cases — only used when the selected product's `unitsPerBox > 1`. */
  boxes: string;
  /** Loose pieces beyond whole boxes — only used when boxed. */
  pieces: string;
}

export const emptyPOLine = (): POLineItem => ({
  productId: "",
  qty: "",
  unitCost: "",
  boxes: "",
  pieces: "",
});

/**
 * Resolve one line to what actually gets submitted/priced: a piece-total `qty`
 * and a per-piece `unitCost`. Boxed lines are typed as Boxes+Pieces and a
 * Cost-per-Box — converted here so `qty * unitCost` (both display and what
 * `createPurchaseOrder` stores as `totalCost`) is correct, and so `qtyOrdered`
 * lands in PIECES to match `qtyReceived` after a receive (ReceivePOModal in
 * PurchaseOrdersReceiveModal.tsx keeps that same piece contract). Non-boxed lines pass through as-is.
 */
export function resolvePOLine(
  line: POLineItem,
  unitsPerBox: number,
): { qty: number; unitCost: number } {
  if (unitsPerBox > 1) {
    const boxes = Math.max(0, Math.trunc(Number(line.boxes) || 0));
    const pieces = Math.max(0, Math.trunc(Number(line.pieces) || 0));
    const qty = normalizeBoxesPieces({ boxes, pieces, unitsPerBox }).qty;
    const costPerBox = Number(line.unitCost) || 0;
    return { qty, unitCost: roundUnitCost(costPerBox / unitsPerBox) };
  }
  return { qty: Number(line.qty) || 0, unitCost: Number(line.unitCost) || 0 };
}
