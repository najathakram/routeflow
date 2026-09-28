/**
 * #2424 (tier 1): an inline-return `returnKey` replay must be a replay of the SAME capture.
 *
 * Every same-(customer, order) replay used to return the stored Return without looking at the
 * items, so a second, DIFFERENT capture that reused the key (an offline-queued capture followed by
 * another on the same order, or a retry with edited lines after an uncertain 5xx that had in fact
 * landed) collapsed into the first, and its lines were silently lost.
 *
 * The capture now stores a canonical fingerprint of its REQUEST items in `Return.capturePayload`,
 * and a replay compares the new request's fingerprint to it. Canonical = one entry per request item
 * with every compared field present (explicit nulls), sorted, so the same items in another order
 * are the same capture. It is re-canonicalised on read too: Postgres `jsonb` does not keep key order.
 */

type CaptureItemLike = {
  productId: string;
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  reason?: string | null;
  condition?: string | null;
  restock?: boolean | null;
};

export type InlineReturnItemsFingerprint = {
  v: 1;
  items: Array<Required<{ [K in keyof CaptureItemLike]: CaptureItemLike[K] | null }>>;
};

export function inlineReturnItemsFingerprint(
  items: readonly CaptureItemLike[],
): InlineReturnItemsFingerprint {
  const canon = items.map((i) => ({
    productId: i.productId,
    boxes: i.boxes ?? null,
    pieces: i.pieces ?? null,
    qty: i.qty ?? null,
    reason: i.reason ?? null,
    condition: i.condition ?? null,
    restock: i.restock ?? null,
  }));
  const key = (x: (typeof canon)[number]) => JSON.stringify(x);
  canon.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { v: 1, items: canon };
}

/**
 * True when a stored `capturePayload` records exactly these request items. A row captured before
 * #2424 has no payload (null): there is nothing to compare, so it is treated as a match (today's
 * replay); anything else unreadable is a mismatch.
 */
export function replayItemsMatch(stored: unknown, items: readonly CaptureItemLike[]): boolean {
  if (stored == null) return true;
  const storedItems = (stored as { items?: unknown }).items;
  if (!Array.isArray(storedItems)) return false;
  return (
    JSON.stringify(inlineReturnItemsFingerprint(storedItems as CaptureItemLike[])) ===
    JSON.stringify(inlineReturnItemsFingerprint(items))
  );
}
