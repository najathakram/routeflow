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

/**
 * Reconciles the `added` draft whose ADD_ITEM change request just succeeded
 * (B795). Apply this as EACH entry resolves during a batch, not only at the
 * end: a later entry's failure stops the batch, and a bare re-tap of "Save
 * changes" rebuilds a fresh diff from `added` at index 0 -- an already-
 * succeeded ADD_ITEM still sitting in `added` gets re-diffed and double-adds
 * the line server-side. CHANGE_QTY/REMOVE_ITEM need no equivalent: the diff
 * is built against a freshly refetched order, so an already-applied edit
 * self-heals (the line's stored qty already matches, so the diff-builder
 * skips it). A no-match `productId` (already dropped, or a non-ADD_ITEM
 * entry) is a no-op and returns the SAME array reference.
 *
 * SUBTRACTS the sent qty/boxes/pieces rather than dropping the draft
 * outright: a driver can re-scan the same product while its ADD_ITEM is
 * still in flight, growing the local draft past what was actually sent.
 * Dropping the whole draft on that entry's success would silently lose the
 * extra units the re-scan added -- an under-bill (Opus review, #1302 round
 * 1). The draft is only removed once nothing sent remains unaccounted for.
 */
export function dropSucceededAddedLine<
  T extends { productId: string; qty: number; boxes?: number; pieces?: number },
>(added: T[], entry: CreateChangeRequestInput): T[] {
  if (entry.type !== "ADD_ITEM" || !entry.productId) return added;
  const idx = added.findIndex((a) => a.productId === entry.productId);
  if (idx === -1) return added;
  const draft = added[idx]!;
  const remainingQty = draft.qty - (entry.qty ?? 0);
  if (remainingQty <= 0) return added.filter((a) => a.productId !== entry.productId);
  const next: T = {
    ...draft,
    qty: remainingQty,
    ...(draft.boxes != null ? { boxes: Math.max(0, draft.boxes - (entry.boxes ?? 0)) } : {}),
    ...(draft.pieces != null ? { pieces: Math.max(0, draft.pieces - (entry.pieces ?? 0)) } : {}),
  };
  return added.map((a, i) => (i === idx ? next : a));
}

/**
 * Row 510: an entry the API refused with the driver's restricted block is NOT applied and NOT declined: its change
 * request stays PENDING for the office to approve with an override. The entry now belongs to the office, so drop its
 * local edit, or a bare re-tap of "Save changes" rebuilds the diff and files a SECOND change request for the same edit.
 * An ADD_ITEM draft is reconciled exactly like a succeeded one (it subtracts what was sent); same no-op rules.
 */
export function dropHandedOffAdded<
  T extends { productId: string; qty: number; boxes?: number; pieces?: number },
>(added: T[], entry: CreateChangeRequestInput): T[] {
  return dropSucceededAddedLine(added, entry);
}

/**
 * The CHANGE_QTY / REMOVE_ITEM half of the same hand-off: the line's edited qty is dropped (the stepper reads the
 * order's own qty again), because the diff against a refetched order would NOT self-heal an edit that is only pending.
 * Returns the SAME object when there is nothing to drop.
 */
export function dropHandedOffQty(
  qtyById: Record<string, number>,
  entry: CreateChangeRequestInput,
): Record<string, number> {
  const id = entry.orderItemId;
  if (!id || !(id in qtyById)) return qtyById;
  const rest = { ...qtyById };
  delete rest[id];
  return rest;
}

/**
 * The toast shown when a batch finishes but `added` still holds units a
 * concurrent re-scan grew mid-flight -- never silently discard them by
 * navigating away (Opus review, #1302 round 2). null when nothing is left.
 */
export function leftoverAddedMessage(added: ReadonlyArray<unknown>): string | null {
  if (added.length === 0) return null;
  return `${added.length} item${added.length === 1 ? "" : "s"} still to send — tap Save again.`;
}
