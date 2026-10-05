import { BadRequestException, ConflictException, HttpException } from "@nestjs/common";
import { IDEMPOTENCY_KEY_CONFLICT, mergeRequestHash } from "../orders/merge-idempotency";

/**
 * B1094: `findOrderIdByIdempotencyKey`'s HELD_BY_OTHER_ORDER 409 names the order that holds the key
 * (`orderId`) — right for staff, a cross-customer leak for a buyer (the key is client-chosen, so a
 * probe would be handed another customer's order id). Re-throw it as the same coded 409 with no
 * identifiers; every other error (the buyer's OWN cart-mismatch 409 included) passes through.
 */
export function scrubForeignOrderId(e: unknown): never {
  const body = e instanceof HttpException ? e.getResponse() : null;
  if (
    body &&
    typeof body === "object" &&
    (body as { code?: string }).code === IDEMPOTENCY_KEY_CONFLICT &&
    (body as { reason?: string }).reason === "HELD_BY_OTHER_ORDER"
  ) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_CONFLICT,
      reason: "HELD_BY_OTHER_ORDER",
      message: "Idempotency-Key already used for a different order",
    });
  }
  throw e;
}

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
