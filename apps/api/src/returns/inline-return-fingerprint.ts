import { ConflictException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * #2424 (tier 1): an inline-return `returnKey` replay must be a replay of the SAME capture.
 *
 * Every same-(customer, order) replay used to return the stored Return without looking at the
 * items, so a second, DIFFERENT capture that reused the key (an offline-queued capture followed by
 * another on the same order, or a retry with edited lines after an uncertain 5xx that had in fact
 * landed) collapsed into the first, and its lines were silently lost.
 *
 * The capture now stores a canonical fingerprint of its REQUEST items in `Return.capturePayload`,
 * and every replay (the capture's own four sites and the order create/merge Idempotency-Key
 * replays) compares the new request's fingerprint to it. Canonical = one entry per request item
 * with every compared field present (explicit nulls) and the EFFECTIVE reason (the item's, else the
 * request's), sorted, so the same items in another order are the same capture. It is
 * re-canonicalised on read too: Postgres `jsonb` does not keep key order.
 *
 * SA-727 (F6): the capture's RESOLUTION is part of what a replay must match. A REFUND capture stores `resolution: "REFUND"`; a
 * STORE_CREDIT capture stores no such key (so every pre-existing payload stays byte for byte what it was, and an absent
 * key reads as STORE_CREDIT). The same key replayed with another resolution is a mismatch, never a silent replay.
 */

/** The 409 code (also `INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS`). */
export const INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS =
  API_ERROR_CODES.INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS;

type CaptureItemLike = {
  productId: string;
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  reason?: string | null;
  condition?: string | null;
  restock?: boolean | null;
  /** #2695: a staff credit-price override prices the capture, so a replay must carry the same one. */
  creditUnitPrice?: number | null;
  overrideReason?: string | null;
};

/** What a replay check needs from a request: its items and its request-level reason. */
export type InlineReturnReplayLines = {
  returnKey?: string;
  items?: readonly CaptureItemLike[];
  reason?: string | null;
  /** SA-727 (F6): the request's resolution (absent = STORE_CREDIT). */
  resolution?: string | null;
};

export type InlineReturnItemsFingerprint = {
  v: 1;
  items: Array<Required<{ [K in keyof CaptureItemLike]: CaptureItemLike[K] | null }>>;
  /** Present ONLY on a REFUND capture; absent = STORE_CREDIT. */
  resolution?: "REFUND";
};

/** The two resolutions a capture can carry; anything but the literal "REFUND" is STORE_CREDIT (the default). */
const resolutionOf = (resolution: unknown): "STORE_CREDIT" | "REFUND" =>
  resolution === "REFUND" ? "REFUND" : "STORE_CREDIT";

export function inlineReturnItemsFingerprint(
  items: readonly CaptureItemLike[],
  requestReason?: string | null,
  resolution?: string | null,
): InlineReturnItemsFingerprint {
  const canon = items.map((i) => ({
    productId: i.productId,
    boxes: i.boxes ?? null,
    pieces: i.pieces ?? null,
    qty: i.qty ?? null,
    reason: i.reason ?? requestReason ?? null, // the EFFECTIVE reason the capture records
    condition: i.condition ?? null,
    restock: i.restock ?? null,
    // #2695: absent on a pre-#2695 payload, re-canonicalised to null — still equal to a request
    // that sends no override, so no stored capture changes its verdict.
    creditUnitPrice: i.creditUnitPrice ?? null,
    overrideReason: typeof i.overrideReason === "string" ? i.overrideReason.trim() : null,
  }));
  const key = (x: (typeof canon)[number]) => JSON.stringify(x);
  canon.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return resolutionOf(resolution) === "REFUND"
    ? { v: 1, items: canon, resolution: "REFUND" }
    : { v: 1, items: canon };
}

/**
 * `match` when a stored `capturePayload` records exactly these request items; `legacy` when the row
 * was captured before #2424 and has no payload (nothing to compare: accepted, and the caller warns);
 * `mismatch` otherwise, including an unreadable payload or a different resolution (F6).
 */
export function replayItemsMatch(
  stored: unknown,
  items: readonly CaptureItemLike[],
  requestReason?: string | null,
  requestResolution?: string | null,
): "match" | "mismatch" | "legacy" {
  if (stored == null) return "legacy";
  const storedItems = (stored as { items?: unknown }).items;
  if (!Array.isArray(storedItems)) return "mismatch";
  // F6: an absent stored `resolution` is STORE_CREDIT; a different request resolution is never a replay
  if (
    resolutionOf((stored as { resolution?: unknown }).resolution) !==
    resolutionOf(requestResolution)
  ) {
    return "mismatch";
  }
  // The stored entries already carry their effective reason, so no request reason is re-applied.
  return JSON.stringify(inlineReturnItemsFingerprint(storedItems as CaptureItemLike[])) ===
    JSON.stringify(inlineReturnItemsFingerprint(items, requestReason))
    ? "match"
    : "mismatch";
}

/**
 * The 409 for a mismatch. The earlier capture WAS recorded (and may already be credited): the body
 * names it, so a client never re-submits the same goods as a "new" return and credits them twice.
 */
export function keyReusedWithDifferentItems(existing: {
  id: string;
  returnNumber?: string | null;
}): ConflictException {
  return new ConflictException({
    code: INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
    returnId: existing.id,
    returnNumber: existing.returnNumber ?? null,
    message:
      `Return ${existing.returnNumber ?? existing.id} was already recorded with this capture key, ` +
      "with different items. It was not changed and nothing new was recorded. Check it before " +
      "returning anything else, so the same goods are not credited twice.",
  });
}

const legacyLogger = new Logger("InlineReturnReplay");

/**
 * Throws the 409 on a mismatch; a legacy (pre-#2424) row is accepted with a warning (the lead's
 * position, SA to confirm). One rule for every replay site.
 */
export function assertReplayItems(
  existing: { id: string; returnNumber?: string | null; capturePayload?: unknown },
  lines: InlineReturnReplayLines,
  logger: { warn(msg: string): void } = legacyLogger,
): void {
  const verdict = replayItemsMatch(
    existing.capturePayload,
    lines.items ?? [],
    lines.reason,
    lines.resolution,
  );
  if (verdict === "mismatch") throw keyReusedWithDifferentItems(existing);
  if (verdict === "legacy")
    logger.warn(
      `#2424: returnKey replay of return ${existing.id} has no capture fingerprint (captured before ` +
        "the fix); accepted as a replay without comparing items",
    );
}
