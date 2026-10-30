/**
 * SA-1042 B9b: a standard return item may name its ORDER LINE (`orderItemId`). This module is the one place that
 * (a) finds the line and reads the count (`resolveLineItems`), (b) caps each line on its own pieces (`assertLineCaps`),
 * and words what is left in the line's own unit (`lineLeftText`). A pooled item (no `orderItemId`) is today's shape and
 * is never touched here: the wire names a line, never a unit (SA-158 (a)). Nothing fails open: a line that is not on the
 * order, an unclear count or a mixed payload is a 400, never read as pooled.
 */
import { BadRequestException } from "@nestjs/common";
import { invoiceLineQtyText } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { capBasis, type OrderForPieces, type OrderLineForPieces } from "./returns-pieces.util";
import type { ProductPackBasis } from "./returns-restock-pieces";

export interface LineItemInput {
  productId: string;
  orderItemId?: string | null;
  qty?: number;
  boxes?: number;
  pieces?: number;
}

/** A line item after resolution. `qty` is what a STANDARD `ReturnItem` stores: the line's own unit (pieces / the factor). */
export interface ResolvedLineItem {
  /** Position in the payload's `items`. */
  index: number;
  /**
   * The order line this item is credited on, or null for a legacy single-unit item (SA-161). SA-1042 A-2: that item still
   * validates the line it names (a 400 on a wrong one) but is POOLED: the column keeps one meaning, so every reader (price,
   * cap, replay, billing check, display) pools it. The row's `sourceOrderItemId` comes from here, never from the DTO.
   */
  orderItemId: string | null;
  productId: string;
  /** The count in pieces, or null for a legacy single-unit line (SA-161), which has no pack and caps in its own unit. */
  pieces: number | null;
  qty: number;
  lineUnit: boolean;
  line: OrderLineForPieces;
}

const bad = (code: string, message: string) => new BadRequestException({ code, message });

export const isLineItem = (item: { orderItemId?: string | null } | null | undefined): boolean =>
  item?.orderItemId != null && item.orderItemId !== "";

/** A line the unit writers shaped: a stored split, or a factor-1 unit (label and snapshot 1). Only these take boxes/pieces. */
const takesSplit = (line: OrderLineForPieces): boolean =>
  line.boxes != null ||
  line.pieces != null ||
  ((line.unitLabel ?? "").trim() !== "" && Number(line.unitsPerBox ?? 0) === 1);

/** Pieces per `boxes` of this line: its own unitsPerBox snapshot (1 on a factor-1 unit line). */
const perBox = (line: OrderLineForPieces): number =>
  line.boxes != null || line.pieces != null ? Number(line.unitsPerBox ?? 0) : 1;

const nonNegInt = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Rule 4. Cases in order, the first hit wins, per item: (a) the line, (b) the product's basis (a mixed or unclassifiable
 * product is today's 409, via `capBasis`), (c) the count; then (d) no product may have both line items and pooled items.
 */
export function resolveLineItems(
  order: OrderForPieces,
  items: LineItemInput[],
  packBases: Map<string, ProductPackBasis>,
): ResolvedLineItem[] {
  const out: ResolvedLineItem[] = [];
  items.forEach((item, index) => {
    if (!isLineItem(item)) return;
    const line = (order.lineItems ?? []).find((l) => l.id === item.orderItemId);
    if (!line || line.status === "CANCELLED" || line.productId !== item.productId)
      throw bad(
        API_ERROR_CODES.RETURN_LINE_NOT_ON_ORDER,
        "That order line is not on this order, or is not for this product.",
      );
    const cap = capBasis(packBases, item.productId);
    const hasSplit = item.boxes != null || item.pieces != null;
    const countShape = (message: string) => bad(API_ERROR_CODES.RETURN_LINE_COUNT_SHAPE, message);
    if (item.qty != null && hasSplit)
      throw countShape("Count a line with qty, or with boxes and pieces, not both.");
    if (cap.mode === "lineUnit") {
      // SA-161: a legacy single-unit product has no pack; it caps (and is priced) in the line's own unit, pooled over the
      // product, so it records no line key (A-2). The named line was validated above.
      if (hasSplit || !(Number(item.qty) > 0))
        throw countShape("This line is counted in its own unit: send qty.");
      out.push({
        index,
        orderItemId: null,
        productId: item.productId,
        pieces: null,
        qty: Number(item.qty),
        lineUnit: true,
        line,
      });
      return;
    }
    let pieces: number;
    if (hasSplit) {
      if (!takesSplit(line))
        throw countShape("This line is not split into boxes and pieces: send qty in its own unit.");
      const per = perBox(line);
      if (!(per > 0) || !nonNegInt(item.boxes ?? 0) || !nonNegInt(item.pieces ?? 0))
        throw countShape("Boxes and pieces must be whole numbers, zero or more.");
      pieces = (item.boxes ?? 0) * per + (item.pieces ?? 0);
    } else if (item.qty != null && Number.isFinite(Number(item.qty))) {
      pieces = Number(item.qty) * cap.factor;
    } else {
      throw countShape("Name a count: qty, or boxes and pieces.");
    }
    out.push({
      index,
      orderItemId: item.orderItemId as string,
      productId: item.productId,
      pieces,
      qty: pieces / cap.factor,
      lineUnit: false,
      line,
    });
  });
  const lineProducts = new Set(out.map((r) => r.productId));
  if (items.some((i) => !isLineItem(i) && lineProducts.has(i.productId)))
    throw bad(
      API_ERROR_CODES.RETURN_LINE_MIXED_WITH_POOLED,
      "A product is returned by line or all together in one return, not both.",
    );
  return out;
}

/**
 * What is left on a line, in the text the form shows (SA-1042 A-8), words from the line's snapshot: a split line "100 pcs
 * (10 boxes)", a factor-1 unit line "5 Cases", a legacy line the bare count in its own unit, as the invoice prints it.
 * `factor` turns the pieces back into the line's unit.
 */
export function lineLeftText(line: OrderLineForPieces, pieces: number, factor: number): string {
  if (line.boxes == null && line.pieces == null) {
    const count = parseFloat((pieces / factor).toFixed(3));
    if (!takesSplit(line)) return invoiceLineQtyText({ qty: count, unitLabel: null });
    return Number.isInteger(count)
      ? invoiceLineQtyText({ qty: count, boxes: count, pieces: 0, unitLabel: line.unitLabel })
      : invoiceLineQtyText({ qty: count, unitLabel: line.unitLabel });
  }
  const per = Number(line.unitsPerBox ?? 0);
  if (!(per > 0)) return `${pieces} pcs`;
  const text = invoiceLineQtyText({
    qty: pieces,
    boxes: Math.floor(pieces / per),
    pieces: pieces % per,
    unitLabel: line.unitLabel,
  });
  return `${pieces} pcs (${text})`;
}

/**
 * Rule 5, the per-LINE cap: the line's pieces, minus prior returns attributed to the line (`priorByLine`, pieces), minus
 * earlier items for the same line in this payload. Over the cap is a 400 naming what is left. The per-PRODUCT pool cap is
 * `create()`'s own and stays. A legacy single-unit item (SA-161) is not capped per line: its lineUnit cap stands.
 */
export function assertLineCaps(
  resolved: ResolvedLineItem[],
  order: OrderForPieces,
  priorByLine: Map<string, number>,
  packBases: Map<string, ProductPackBasis>,
): void {
  const used = new Map<string, number>();
  for (const r of resolved) {
    if (r.lineUnit || r.pieces == null || r.orderItemId == null) continue;
    const cap = capBasis(packBases, r.productId);
    const factor = cap.mode === "pieces" ? cap.factor : 1;
    const line = (order.lineItems ?? []).find((l) => l.id === r.orderItemId) ?? r.line;
    const total = Number(line.qty) * factor;
    const taken = (priorByLine.get(r.orderItemId) ?? 0) + (used.get(r.orderItemId) ?? 0);
    const left = Math.max(0, total - taken);
    if (r.pieces > left + 1e-9)
      throw new BadRequestException(
        `Return qty exceeds what is left on this line: ${lineLeftText(line, left, factor)}.`,
      );
    used.set(r.orderItemId, (used.get(r.orderItemId) ?? 0) + r.pieces);
  }
}

// ── Rule 7: price per line ─────────────────────────────────────────────────────────────────────────────────────────────

interface GroupableItem {
  productId: string;
  qty: unknown;
  sourceOrderItemId?: string | null;
}

/** The group a returned item is priced and itemised under: its product, and its order line when it names one. */
export const returnGroupKey = (item: {
  productId: string;
  sourceOrderItemId?: string | null;
}): string =>
  item.sourceOrderItemId ? `${item.productId}|${item.sourceOrderItemId}` : item.productId;

export interface ReturnGroup {
  key: string;
  productId: string;
  /** The order line of a line group; null for the pooled group of a product. */
  orderItemId: string | null;
  /** The group's returned qty, in the line's own unit. */
  qty: number;
}

/** Returned items grouped by `returnGroupKey`, qty summed, in first-seen order. The ONE grouping the preview and the mint share. */
export function groupReturnItems(items: GroupableItem[]): Map<string, ReturnGroup> {
  const out = new Map<string, ReturnGroup>();
  for (const it of items) {
    const key = returnGroupKey(it);
    const cur = out.get(key);
    if (cur) cur.qty += Number(it.qty);
    else
      out.set(key, {
        key,
        productId: it.productId,
        orderItemId: it.sourceOrderItemId || null,
        qty: Number(it.qty),
      });
  }
  return out;
}

/** The invoice items a group is credited against: a line group's are the items billed from that order line; a pooled group's, all of the product's. */
export function groupInvoiceItems<T>(
  group: Pick<ReturnGroup, "productId" | "orderItemId">,
  invoiceItems: readonly T[],
): T[] {
  return invoiceItems.filter((it) => {
    const row = it as { productId?: string | null; orderItemId?: string | null };
    return (
      row.productId === group.productId &&
      (group.orderItemId == null || row.orderItemId === group.orderItemId)
    );
  });
}

/** The order line a standard item names, as the wire shows it (a snapshot of the line, never the live product), or null. */
export function lineOfItem(
  item: { sourceOrderItemId?: string | null },
  order: OrderForPieces | null | undefined,
): {
  unitLabel: string | null;
  unitsPerBox: number | null;
  boxes: number | null;
  pieces: number | null;
  qty: number;
} | null {
  if (!item.sourceOrderItemId) return null;
  const line = (order?.lineItems ?? []).find((l) => l.id === item.sourceOrderItemId);
  if (!line) return null;
  return {
    unitLabel: line.unitLabel ?? null,
    unitsPerBox: line.unitsPerBox != null ? Number(line.unitsPerBox) : null,
    boxes: line.boxes != null ? Number(line.boxes) : null,
    pieces: line.pieces != null ? Number(line.pieces) : null,
    qty: Number(line.qty),
  };
}

/** Each item with its order line (`line`, rule 8), from the order the read already holds. */
export const withLines = <T extends { sourceOrderItemId?: string | null }>(
  items: T[] | null | undefined,
  order: OrderForPieces | null | undefined,
) => (items ?? []).map((it) => ({ ...it, line: lineOfItem(it, order) }));
