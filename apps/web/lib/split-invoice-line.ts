import { computeLineSubtotal, prorateLineSubtotal } from "@routeflow/pricing";

type Numeric = number | string | null | undefined;

/**
 * One order line as the split-invoice modal needs it. `subtotal` is REQUIRED (null = the order line
 * has none stored) so a caller cannot forget it: without it the preview has nothing to prorate and a
 * boxed line (qty = pieces, unitPrice = BOX price) previews unitsPerBox times too much.
 */
export interface SplitInvoiceLine {
  id: string;
  productName: string;
  qty: number;
  invoicedQty: number;
  unitPrice: number;
  /** Stored order-line subtotal — the agreed money the server prorates. */
  subtotal: number | null;
  /** Stored box/piece split (null = `qty` is in selling units, not pieces). */
  boxes: number | null;
  pieces: number | null;
  /** Sale-time box size (the order line's own snapshot, else the live product's). */
  unitsPerBox: number | null;
  /** BUY_N_GET_M snapshot: whole free selling units on the line. */
  promoFreeUnits: number | null;
  unit?: string;
}

/** The slice of an order line (`OrderItem`, or the order page's untyped line) the mapper reads. */
export interface SplitSourceLine {
  id: string;
  qty: Numeric;
  invoicedQty?: Numeric;
  unitPrice: Numeric;
  subtotal?: Numeric;
  boxes?: Numeric;
  pieces?: Numeric;
  unitsPerBox?: Numeric;
  promoFreeUnits?: Numeric;
  product?: { unit?: string | null; unitsPerBox?: Numeric } | null;
}

const optNum = (v: Numeric): number | null => (v == null ? null : Number(v));

/** THE order line -> modal line mapper. Every `SplitInvoiceModal` caller goes through it. */
export function toSplitInvoiceLine(li: SplitSourceLine, productName: string): SplitInvoiceLine {
  return {
    id: li.id,
    productName,
    qty: Number(li.qty),
    invoicedQty: Number(li.invoicedQty ?? 0),
    unitPrice: Number(li.unitPrice),
    subtotal: optNum(li.subtotal),
    boxes: optNum(li.boxes),
    pieces: optNum(li.pieces),
    unitsPerBox: optNum(li.unitsPerBox) ?? optNum(li.product?.unitsPerBox),
    promoFreeUnits: optNum(li.promoFreeUnits),
    unit: li.product?.unit ?? undefined,
  };
}

/**
 * Preview money for billing `billQty` of an order line as the NEXT partial invoice — the server's
 * `buildInvoiceItemData` (telescoping cumulative rounding keyed on `invoicedQty`, on the PAID basis
 * when the line has free units), via `prorateLineSubtotal`. A free unit is a whole selling unit:
 * `unitsPerBox` pieces on a box-split line, one qty unit otherwise.
 *
 * With no stored subtotal the agreed money is re-priced boxed-aware with `computeLineSubtotal`
 * (never `qty * unitPrice`) and prorated the same way.
 */
export function previewSplitLineTotal(line: SplitInvoiceLine, billQty: number): number {
  if (!(line.qty > 0)) return 0;
  const freeUnits = Math.max(0, Math.trunc(Number(line.promoFreeUnits ?? 0) || 0));
  const isBoxSplit = line.boxes != null;
  const freeUnitSize = isBoxSplit && Number(line.unitsPerBox) > 0 ? Number(line.unitsPerBox) : 1;
  const stored =
    line.subtotal != null
      ? line.subtotal
      : computeLineSubtotal({
          unitPrice: line.unitPrice,
          qty: line.qty,
          boxes: line.boxes,
          pieces: line.pieces,
          unitsPerBox: line.unitsPerBox,
          freeUnits,
        });
  return prorateLineSubtotal(
    stored,
    billQty,
    line.qty,
    freeUnits,
    freeUnitSize,
    Math.max(0, line.invoicedQty),
  );
}
