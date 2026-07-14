/**
 * Build the at-door "Adjust order" change-request diff (mirrors the structure/
 * spirit of `lib/order-item-diff.ts`: diff original vs. edited state → a minimal
 * set of server-bound operations), targeting `CreateChangeRequestInput[]` instead
 * of a PATCH-items payload — the P5-09 change-request engine, not direct edit.
 */
import type { CreateChangeRequestInput } from "./api/change-requests";

const EPS = 0.0001;

export interface AtDoorOriginalLine {
  id: string;
  qty: number;
  status: string;
  /** Lines already (partially) delivered are never adjustable — server 409s (LINE_ALREADY_DELIVERED). */
  deliveredQty?: number;
}

/** One entry per line the driver actually touched (untouched lines are simply absent). */
export interface AtDoorEditedLine {
  lineId: string;
  qty: number;
}

export interface AtDoorAddedLine {
  productId: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
}

/**
 * Build the minimal set of change-request creations for an at-door adjustment.
 * - Untouched original lines → nothing.
 * - Edited qty → 0 → REMOVE_ITEM.
 * - Edited qty → any other changed value → CHANGE_QTY (newQty is ABSOLUTE, not a delta).
 * - Already-delivered/cancelled originals are skipped even if present in `edited` (defensive —
 *   the adjust screen should never offer a stepper for them, this is belt-and-suspenders).
 * - New scanned products → ADD_ITEM.
 */
export function buildAtDoorChangeRequests(args: {
  originals: AtDoorOriginalLine[];
  edited: AtDoorEditedLine[];
  added: AtDoorAddedLine[];
}): CreateChangeRequestInput[] {
  const { originals, edited, added } = args;
  const byId = new Map(originals.map((o) => [o.id, o]));
  const out: CreateChangeRequestInput[] = [];

  for (const e of edited) {
    const orig = byId.get(e.lineId);
    if (!orig) continue;
    if (orig.status === "CANCELLED") continue;
    if (Number(orig.deliveredQty ?? 0) > 0) continue;
    if (Math.abs(e.qty - orig.qty) < EPS) continue; // no real change
    if (e.qty <= 0) {
      out.push({ type: "REMOVE_ITEM", orderItemId: orig.id });
    } else {
      out.push({ type: "CHANGE_QTY", orderItemId: orig.id, qty: e.qty });
    }
  }

  for (const a of added) {
    if (a.qty <= 0) continue;
    out.push({
      type: "ADD_ITEM",
      productId: a.productId,
      qty: a.qty,
      ...(a.boxes != null ? { boxes: a.boxes } : {}),
      ...(a.pieces != null ? { pieces: a.pieces } : {}),
    });
  }

  return out;
}
