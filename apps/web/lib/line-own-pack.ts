import { resolveStoredLinePack } from "@routeflow/pricing";

/** The order-line fields the answer reads (a structural slice of `OrderItem`, Decimals arrive as numbers or strings). */
export interface OwnPackLine {
  productId?: string | null;
  qty: number | string;
  boxes?: number | string | null;
  pieces?: number | string | null;
  unitsPerBox?: number | string | null;
  unitLabel?: string | null;
  unitPrice: number | string;
  subtotal?: number | string | null;
  promoFreeUnits?: number | string | null;
  product?: { unitsPerBox?: number | string | null } | null;
}

/**
 * SA-1097 A-2: the pack a STORED box-split line was sold in, as the server's edit reads it (the same
 * `resolveStoredLinePack`, so the preview and the payload agree with what the API will accept).
 *  - `as-stored`: not a stored split line without a snapshot (it has its own snapshot, no split, a unit label
 *    or no product), so the line's snapshot / the live product answers as before.
 *  - `pack`: the line's own pack. `none`: it was sold with no pack (priced qty x price).
 *  - `unreadable`: neither the split nor the money can say; the server refuses an edit of it.
 */
export type LineOwnPack =
  | { kind: "as-stored" }
  | { kind: "pack"; pack: number }
  | { kind: "none" }
  | { kind: "unreadable" };

export function lineOwnPack(li: OwnPackLine): LineOwnPack {
  if (!li.productId || li.unitLabel != null || li.boxes == null) return { kind: "as-stored" };
  if (Number(li.unitsPerBox ?? 0) > 1) return { kind: "as-stored" };
  const livePack = li.product?.unitsPerBox == null ? undefined : Number(li.product.unitsPerBox);
  const r = resolveStoredLinePack({
    qty: Number(li.qty),
    boxes: Number(li.boxes),
    pieces: li.pieces == null ? null : Number(li.pieces),
    unitsPerBox: li.unitsPerBox == null ? null : Number(li.unitsPerBox),
    unitPrice: Number(li.unitPrice),
    subtotal: Number(li.subtotal ?? 0),
    freeUnits: Number(li.promoFreeUnits ?? 0),
    livePack,
  });
  if (!r.ok) return { kind: "unreadable" };
  return r.pack === null ? { kind: "none" } : { kind: "pack", pack: r.pack };
}

/**
 * The pack a screen shows or splits a line at: the line's own (snapshot, then the stored-line answer), never
 * today's product pack for a stored split line. null = no pack (or none readable).
 */
export function lineDisplayPack(li: OwnPackLine): number | null {
  const own = lineOwnPack(li);
  if (own.kind === "pack") return own.pack;
  if (own.kind === "none" || own.kind === "unreadable") return null;
  const pack = li.unitsPerBox ?? li.product?.unitsPerBox ?? null;
  return pack == null ? null : Number(pack);
}
