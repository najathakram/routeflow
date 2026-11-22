import {
  DEFAULT_BASE_LABEL,
  DEFAULT_PACK_LABEL,
  billPlanFromPO,
  type BillLineFromPO,
} from "@routeflow/pricing";
import type { POItem } from "@/app/(dashboard)/inventory/_components/purchase-orders-shared";

/**
 * SA-1207 P2b: a purchase order as a new supplier bill, in the PO's own units. The money and the unit
 * come from `billPlanFromPO` (@routeflow/pricing), never from here: a bare `qty` is BOXES to the API.
 */

/** A bill form row, in the line's own unit (boxes, 1 lot, or pieces). */
export interface PoPrefillRow {
  productId: string;
  description: string;
  unit: string;
  qty: string;
  unitCost: string;
  packSize?: number;
  unitLabel?: string;
}

export interface PoForPrefill {
  id: string;
  poNumber: string;
  supplier?: { id: string } | null;
  items: POItem[];
}

export interface PoBillPrefill {
  poId: string;
  poNumber: string;
  supplierId: string;
  rows: PoPrefillRow[];
  /** Lines to enter by hand: what the PO line is called. Never billed as a guess. */
  byHand: string[];
  /** Lines with nothing to bill (received 0 on a part-received PO). */
  zeroCount: number;
}

const nameOf = (item: POItem) => item.product?.name ?? item.sku ?? "Item";

function toRow(item: POItem, line: BillLineFromPO): PoPrefillRow {
  const unit =
    line.unitLabel ??
    (line.packSize ? DEFAULT_PACK_LABEL : (item.product?.unit ?? DEFAULT_BASE_LABEL));
  return {
    productId: line.productId,
    description: nameOf(item),
    unit,
    qty: String(line.qty),
    unitCost: String(line.unitCost),
    ...(line.packSize ? { packSize: line.packSize } : {}),
    ...(line.unitLabel ? { unitLabel: line.unitLabel } : {}),
  };
}

/** Rows + the lines to enter by hand: every PO line lands in exactly one of rows, byHand or zeroCount. */
export function prefillBillFromPO(po: PoForPrefill): PoBillPrefill {
  const items = po.items ?? [];
  const plan = billPlanFromPO(items);
  return {
    poId: po.id,
    poNumber: po.poNumber,
    supplierId: po.supplier?.id ?? "",
    rows: plan.lines.map((line, k) => toRow(items[plan.lineIndex[k]], line)),
    byHand: plan.byHand.map((i) => nameOf(items[i])),
    zeroCount: plan.zero.length,
  };
}

/** A form row as the create-bill payload line (before this, the form sent only qty, cost and product). */
export function billItemFromRow(row: PoPrefillRow | Omit<PoPrefillRow, never>) {
  return {
    description: row.description.trim(),
    qty: parseFloat(row.qty),
    unitCost: parseFloat(row.unitCost),
    productId: row.productId || undefined,
  };
}
