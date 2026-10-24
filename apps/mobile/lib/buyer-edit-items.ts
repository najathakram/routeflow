import { formatQtySplit } from "@routeflow/pricing";
import type { BuyerOrderItemEdit } from "@routeflow/types";
import { unitLineCount } from "./edit-items-draft";
import { invoiceLineUnitNoun } from "./invoice-line-display";

/**
 * #2270 (lead ruling, option A): the buyer edit-items screen's pure half.
 *
 * The server refuses EVERY buyer edit of an order that holds a live unit line (units_v1 Case,
 * Pallet…): the full-list replace gets 409 UNIT_AWARE_LINE (`assertOrderEditAllowed`,
 * apps/api/src/orders/unit-aware-guard.ts), and the only shape that guard lets through — a
 * DELETE-only diff — is then refused 400 for any buyer by `classifyEditPayload`
 * (order-edit-payload.ts). So such an order is READ-ONLY here: the screen says so up front and
 * never sends a request. Every other order keeps the replace-by-product payload byte for byte.
 */

export interface BuyerOrderLineLike {
  id: string;
  /** Null for a seller-added custom (unlisted) line — which has no `product` either. */
  productId: string | null;
  qty: number | string;
  unitPrice: number | string;
  boxes?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  status?: string | null;
  product?: { name?: string; unit?: string } | null;
}

export interface BuyerDraftItem {
  /**
   * B297 row 352: the stored line this row edits — Save names it so the line keeps the rate it was sold at.
   * Unset on a row added from the catalog in this session (a new line). The draft is keyed by this id,
   * else by the product: after a rate change one product can be two lines.
   */
  orderItemId?: string;
  productId: string;
  name: string;
  unit?: string;
  /** Set only when the count below is the unit's COUNT, so the row never reads "48 / Case". */
  unitLabel?: string | null;
  qty: number;
  unitPrice: number;
  /** A live unit line whose COUNT can't be derived (SA-388 LOCKED) — shown as "locked", never a number. */
  locked?: boolean;
}

/**
 * B889: a seller-added custom (unlisted) line — no catalog product. The buyer can't edit one (the
 * server's buyer replace preserves it and ignores any payload entry for it, B51), so the draft
 * skips it and the screen says so, exactly as web does (buyer orders/[id]/page.tsx).
 */
export function isCustomLine(li: Pick<BuyerOrderLineLike, "productId">): boolean {
  // productId ONLY (lead fold, #2709): a CATALOG line whose product relation is missing must stay,
  // or the replace-by-product Save would delete it.
  return !li.productId;
}

/** Live (non-cancelled) custom lines on the order — the note shows when this is > 0. */
export function customLineCount(lines: readonly BuyerOrderLineLike[]): number {
  return lines.filter((li) => isCustomLine(li) && li.status !== "CANCELLED").length;
}

/** Web's wording (custom-line-edit-note), verbatim. */
export const CUSTOM_LINES_NOTE =
  "Custom items added by the seller aren't listed here — they stay on your order as they are.";

/** Mirrors the server's `isUnitAwareLine` exactly (unit-aware-guard.ts). */
export function isBuyerUnitLine(li: Pick<BuyerOrderLineLike, "unitLabel" | "status">): boolean {
  return li.unitLabel != null && li.unitLabel !== "" && li.status !== "CANCELLED";
}

/** The unit named in the read-only notice — the first live unit line's own label; null = none. */
export function orderUnitLabel(lines: readonly BuyerOrderLineLike[]): string | null {
  const hit = lines.find(isBuyerUnitLine);
  return hit ? (hit.unitLabel ?? "").trim() || "Unit" : null;
}

export function readOnlyNotice(unitLabel: string): string {
  return `This order has ${unitLabel} lines, so it can't be changed here yet — ask your supplier to adjust it.`;
}

/**
 * The draft the screen edits. A unit line shows its COUNT via SA-388's derivation
 * (`unitLineCount`: boxes when a positive integer, else qty ÷ snapshot unitsPerBox when a whole
 * multiple). A line whose count can't be derived keeps its stored qty WITHOUT the unit label — the
 * screen never pairs base pieces with "/ Case".
 */
/** A draft row's key: its stored line, else (a catalog add) its product. */
export function draftKey(i: Pick<BuyerDraftItem, "orderItemId" | "productId">): string {
  return i.orderItemId ?? i.productId;
}

export function hydrateBuyerDraft(
  lines: readonly BuyerOrderLineLike[],
): Record<string, BuyerDraftItem> {
  const draft: Record<string, BuyerDraftItem> = {};
  for (const li of lines) {
    if (!(Number(li.qty) > 0)) continue; // the screen's long-standing filter, unchanged
    // #2316 review + F2 (tier 1): a CANCELLED line never joins the draft. The buyer path is a
    // replace-by-product, so a cancelled line left in the draft is RE-CREATED on Save — a cancelled
    // Case line came back as 24 boxes. Unit or pack, it stays cancelled.
    if (li.status === "CANCELLED") continue;
    // B889: a custom line was keyed "null" (several collapsed into one "Product" row) and its edit
    // was silently ignored server-side. It stays on the order untouched; the screen notes it.
    if (isCustomLine(li) || !li.productId) continue; // (!li.productId narrows the type)
    const unitLine = isBuyerUnitLine(li);
    const count = unitLine ? unitLineCount(li) : null;
    draft[li.id] = {
      orderItemId: li.id,
      productId: li.productId,
      name: li.product?.name ?? "Product",
      unit: li.product?.unit,
      unitLabel: count != null ? li.unitLabel : null,
      qty: count ?? Number(li.qty),
      unitPrice: Number(li.unitPrice),
      ...(unitLine && count == null ? { locked: true } : {}),
    };
  }
  return draft;
}

/**
 * #2316 review (Opus BLOCK): the quantity TEXT a read-only row shows, since its steppers are
 * hidden — a unit line reads "4 Cases" / "1 Case" (its COUNT, named by invoiceLineUnitNoun and
 * pluralised by the shared formatQtySplit), a LOCKED one reads "locked", a pack line its qty.
 */
export function readOnlyQtyText(item: BuyerDraftItem): string {
  if (item.locked) return "locked";
  if (item.unitLabel?.trim()) {
    return formatQtySplit({
      qty: item.qty,
      boxes: item.qty,
      pieces: 0,
      boxLabel: invoiceLineUnitNoun(item),
    });
  }
  return item.unit
    ? `${formatQtySplit({ qty: item.qty })} ${item.unit}`
    : formatQtySplit({ qty: item.qty });
}

export type BuyerSavePlan =
  { kind: "refuse"; message: string } | { kind: "replace"; items: BuyerOrderItemEdit[] };

/**
 * What Save does. No live unit line on the order: the existing replace-by-product payload,
 * unchanged. A unit line present: refused locally with the read-only notice and NO request —
 * the screen hides Save for such an order anyway; this is the belt to that brace.
 */
export function buyerSavePlan(
  lines: readonly BuyerOrderLineLike[],
  draft: Record<string, BuyerDraftItem>,
): BuyerSavePlan {
  const unitLabel = orderUnitLabel(lines);
  if (unitLabel != null) return { kind: "refuse", message: readOnlyNotice(unitLabel) };
  // B889 belt: Save never sends a null productId, whatever reached the draft.
  const kept = Object.values(draft).filter((i) => i.qty > 0 && !!i.productId);
  if (kept.length === 0) return { kind: "refuse", message: "Add at least one item." };
  return {
    kind: "replace",
    items: kept.map((i) => ({
      productId: i.productId,
      qty: i.qty,
      ...(i.orderItemId ? { orderItemId: i.orderItemId } : {}),
    })),
  };
}
