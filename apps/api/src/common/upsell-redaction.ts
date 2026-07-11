import { isUpsellLine } from "./pricing";

/**
 * Customer-facing redaction for UPSELL lines.
 *
 * An upsell (operator sold a line ABOVE catalog) is stored as a MANUAL override
 * with the catalog base in `originalPrice` and the higher net in `unitPrice`
 * (see the discount convention in pricing.ts). The customer must never learn the
 * base price nor that they were upsold, so before any order/invoice reaches a
 * customer we:
 *   - null `originalPrice`  → no strikethrough / "was" price
 *   - set `priceType = STANDARD` → no "Special"/"Adjusted" pill
 *   - drop `product.pricePerUnit` (the base sitting next to a higher unitPrice is
 *     itself the tell) and `product.averageCost` (a pre-existing cost leak).
 *
 * The money (`unitPrice`/`subtotal`) is untouched — the customer is charged the
 * upsold price, they just can't see the base it was derived from. DISCOUNT lines
 * are left intact so buyers keep seeing their genuine savings. Idempotent: a
 * redacted line is STANDARD with a null originalPrice, so it no longer matches.
 */

interface RedactableLine {
  priceType?: string | null;
  unitPrice: unknown;
  originalPrice?: unknown;
  product?: { pricePerUnit?: unknown; averageCost?: unknown } | null;
}

/**
 * Redact an array of order/invoice line items in place. Accepts `unknown` so it
 * composes with Prisma's rich (Decimal-typed) result objects without a structural
 * constraint fight — a runtime `Array.isArray` guard makes the cast safe.
 */
export function redactUpsellLines(lines: unknown): void {
  if (!Array.isArray(lines)) return;
  for (const line of lines as RedactableLine[]) {
    if (isUpsellLine(line as Parameters<typeof isUpsellLine>[0])) {
      line.originalPrice = null;
      line.priceType = "STANDARD";
    }
    if (line.product) {
      delete line.product.pricePerUnit;
      delete line.product.averageCost;
    }
  }
}

/**
 * Redact an order (`lineItems`) or invoice (`items`) entity in place and return
 * it (type preserved). Safe to call on either shape, on null, and on
 * already-redacted data.
 */
export function redactUpsellForCustomer<T>(entity: T): T {
  if (!entity || typeof entity !== "object") return entity;
  const e = entity as { lineItems?: unknown; items?: unknown };
  redactUpsellLines(e.lineItems);
  redactUpsellLines(e.items);
  return entity;
}
