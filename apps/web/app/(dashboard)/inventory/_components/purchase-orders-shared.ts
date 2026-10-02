import {
  buildPOLine,
  derivedCaseCost,
  linePack,
  normalizeBoxesPieces,
  roundMoney,
  type POLineAmounts,
} from "@routeflow/pricing";
import type { PurchaseOrderBillLink, PurchaseOrderReceipt } from "@routeflow/types";

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
  /** The supplier's own SKU / pieces-per-supplier-unit — null on lines that never carried them. */
  sku?: string | null;
  packSize?: number | null;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplier: Supplier;
  status: POStatus;
  items: POItem[];
  /**
   * The server-stored document total: the raw Prisma `PurchaseOrder.totalAmount` (`Decimal(10,2)`), so a
   * numeric STRING. B719 (#1485): this type used to declare a `total` the API never sends, so the list's
   * Total column read `undefined` and showed $0.00 on every row. Read it through `poDisplayTotal` (@routeflow/pricing).
   */
  totalAmount?: number | string | null;
  expectedDate: string;
  notes?: string;
  createdAt: string;
  /** Detail read only (`GET /inventory/purchase-orders/:id`): the receipts history and the linked bill. */
  receipts?: PurchaseOrderReceipt[];
  vendorBill?: PurchaseOrderBillLink | null;
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
 * A PO line's money, from the ENTERED figures, through the one `@routeflow/pricing` builder (`buildPOLine`;
 * no money math lives here). A boxed line (`unitsPerBox > 1`) is entered as Boxes+Pieces at a Cost-per-Box:
 * its total is roundMoney(costPerBox x pieces / unitsPerBox), exact, NOT pieces x a rounded per-piece cost
 * (1,000 boxes of 12 at $11.00 is $11,000.00; the per-piece route gave $11,000.40). The per-piece `unitCost`
 * (4 dp) is for costing only. A non-boxed line is per piece: roundMoney(qty x unitCost). Never throws: an
 * unusable entry is an all-zero line (the forms validate it separately).
 */
export interface POLineResolved extends POLineAmounts {
  /** Whole cases and loose pieces of a boxed line (null for a per-piece line): the wire quantity. */
  cases: number | null;
  loosePieces: number | null;
}

export function resolvePOLineAmounts(line: POLineItem, unitsPerBox: number): POLineResolved {
  try {
    if (unitsPerBox > 1) {
      const boxes = Math.max(0, Math.trunc(Number(line.boxes) || 0));
      const pieces = Math.max(0, Math.trunc(Number(line.pieces) || 0));
      const split = normalizeBoxesPieces({ boxes, pieces, unitsPerBox });
      const cases = split.boxes ?? 0;
      const loosePieces = split.pieces ?? 0;
      return {
        ...buildPOLine({
          packSize: unitsPerBox,
          caseCost: Number(line.unitCost) || 0,
          cases,
          loosePieces,
        }),
        cases,
        loosePieces,
      };
    }
    return {
      ...buildPOLine({ qtyOrdered: Number(line.qty) || 0, unitCost: Number(line.unitCost) || 0 }),
      cases: null,
      loosePieces: null,
    };
  } catch {
    return {
      qtyOrdered: 0,
      unitCost: 0,
      totalCost: 0,
      packSize: null,
      caseCost: null,
      cases: null,
      loosePieces: null,
    };
  }
}

/**
 * The money of a STORED line (a `POItem` as `GET /inventory/purchase-orders/:id` returns it) for display.
 * A boxed line's stored `unitCost` is the per-piece figure at 4 dp, for costing only: `qtyOrdered x unitCost`
 * is the exact drift #1199 fixed (1,000 cases of $11.00 stored at $11,000.00 read back as $11,000.40). The
 * document figure is the stored exact `totalCost`, so it wins whenever the row carries one; a row without
 * it (or an unusable one) is rebuilt through the one `@routeflow/pricing` builder from the case cost
 * `derivedCaseCost` reads back, which shows an OLD drifted row honestly rather than masking it.
 */
// B699/B722: `linePack` moved to `@routeflow/pricing` (mobile's PO detail screen
// needed the identical stored-wins rule and had none — #2066 review round);
// re-exported under this file's original name so every existing
// `from "./purchase-orders-shared"` import of it keeps working unchanged.
export { linePack };

export function resolveStoredPOLineAmounts(
  item: Pick<POItem, "qtyOrdered" | "unitCost" | "totalCost" | "packSize">,
  livePack: number,
): POLineResolved {
  const unitsPerBox = linePack(item, livePack);
  const qtyOrdered = Math.max(0, Number(item.qtyOrdered) || 0);
  const unitCost = Math.max(0, Number(item.unitCost) || 0);
  const stored = item.totalCost != null ? Number(item.totalCost) : NaN;
  const exact = Number.isFinite(stored) && stored >= 0 ? roundMoney(stored) : null;
  const withExact = (a: POLineResolved): POLineResolved =>
    exact == null ? a : { ...a, totalCost: exact };
  try {
    if (unitsPerBox > 1) {
      const split = normalizeBoxesPieces({ qty: Math.trunc(qtyOrdered), unitsPerBox });
      const cases = split.boxes ?? 0;
      const loosePieces = split.pieces ?? 0;
      const caseCost = derivedCaseCost(unitCost, unitsPerBox, { totalCost: exact, qtyOrdered });
      return withExact({
        ...buildPOLine({ packSize: unitsPerBox, caseCost, cases, loosePieces }),
        cases,
        loosePieces,
      });
    }
    return withExact({
      ...buildPOLine({ qtyOrdered, unitCost }),
      cases: null,
      loosePieces: null,
    });
  } catch {
    return {
      qtyOrdered,
      unitCost,
      totalCost: exact ?? 0,
      packSize: null,
      caseCost: null,
      cases: null,
      loosePieces: null,
    };
  }
}

/**
 * Resolve one line to a piece-total `qty` and a per-piece `unitCost` (validation and display of the piece
 * quantity; `qtyOrdered` lands in PIECES to match `qtyReceived` after a receive, ReceivePOModal keeps that
 * piece contract). The MONEY of a line is `resolvePOLineAmounts(...).totalCost`, never `qty * unitCost`.
 * Non-boxed lines pass through as typed.
 */
export function resolvePOLine(
  line: POLineItem,
  unitsPerBox: number,
): { qty: number; unitCost: number } {
  if (unitsPerBox > 1) {
    const a = resolvePOLineAmounts(line, unitsPerBox);
    return { qty: a.qtyOrdered, unitCost: a.unitCost };
  }
  return { qty: Number(line.qty) || 0, unitCost: Number(line.unitCost) || 0 };
}

/**
 * The line as `POST /inventory/purchase-orders` takes it: a boxed line goes as the ENTERED case figures (the
 * server computes the exact total and ignores any client figure), a per-piece line as pieces and a per-piece
 * cost.
 */
export function toCreateItem(line: POLineItem, unitsPerBox: number) {
  if (unitsPerBox > 1) {
    const a = resolvePOLineAmounts(line, unitsPerBox);
    return {
      productId: line.productId,
      packSize: unitsPerBox,
      caseCost: a.caseCost ?? 0,
      cases: a.cases ?? 0,
      loosePieces: a.loosePieces ?? 0,
    };
  }
  const { qty, unitCost } = resolvePOLine(line, unitsPerBox);
  return { productId: line.productId, qty, unitCost };
}
