import { BadRequestException } from "@nestjs/common";
import { mergeRequestHash } from "../orders/merge-idempotency";

/**
 * B1094: the `Idempotency-Key` for `POST /buyer/orders` — the same client-chosen, bounded token the
 * staff `POST /orders` accepts (OrdersController.normalizeIdempotencyKey): one printable-ASCII token
 * of at most 128 chars, written straight into a btree unique index, so an oversized one is refused here
 * at the edge rather than surfacing as a raw index-row-size 500. Absent or blank = "no key" (the
 * pre-B1094 behaviour, unchanged), never "the empty key".
 */
export function normalizeBuyerIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const key = raw.trim();
  if (!key) return undefined;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestException(
      "Idempotency-Key must be at most 128 printable characters with no spaces",
    );
  }
  return key;
}

/**
 * The fingerprint a same-key retry must match to be replayed: the customer and the cart's lines (order
 * and key order normalised away by `mergeRequestHash`). Header fields (notes, urgent, date) are not
 * part of the cart's identity — they are applied best-effort after the lines land.
 */
export function buyerSubmitHash(customerId: string, items: readonly unknown[] | undefined): string {
  return mergeRequestHash({ customerId, items });
}
