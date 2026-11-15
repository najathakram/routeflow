import {
  DISCOUNT_PRE_TAX_FROM,
  MoneyInvariantError,
  discountTaxBaseOf,
  isNsfLine,
  type DiscountTaxBase,
} from "@routeflow/pricing";

/**
 * SA-1141 / W-989 (R3, R4): the discount tax base of ONE document, as a pure function of the `createdAt` of the document its
 * money DERIVES from, read against the one cutover constant (`DISCOUNT_PRE_TAX_FROM`, `null` while dark: every document LEGACY).
 *
 *   - an invoice cut from an order reads the ORDER's `createdAt` (order and invoice parity, SA-918);
 *   - an invoice converted from an estimate reads the ESTIMATE's (the quoted tax must not move);
 *   - every other document (a manual invoice, a duplicate, a standing order, a counter sale) reads its own.
 *
 * `order` / `estimate` are the selected relations (`DISCOUNT_SOURCE_SELECT`). With the cutover set, an invoice that names an
 * order (`orderId`) but arrives without it is a loader bug: refused loudly (never a silent mode); so is an invoice (it has an
 * `orderId` key) with no resolved order that arrives without its `estimate` (SA-1153 G). Dark it never reads a date.
 */
export interface DiscountModeDoc {
  createdAt?: Date | string | null;
  orderId?: string | null;
  order?: { createdAt?: Date | string | null } | null;
  estimate?: { createdAt?: Date | string | null } | null;
}

/** The relations a loader adds so `discountModeOf` can resolve an invoice's source (one scalar each, no new query shape). */
export const DISCOUNT_SOURCE_SELECT = {
  order: { select: { createdAt: true } },
  estimate: { select: { createdAt: true } },
} as const;

export function discountModeOf(
  doc: DiscountModeDoc | null | undefined,
  from: Date | null = DISCOUNT_PRE_TAX_FROM,
): DiscountTaxBase {
  if (from == null) return "LEGACY_POST_TAX";
  if (doc?.orderId && doc.order?.createdAt == null) {
    throw new MoneyInvariantError(
      "Discount tax base: an order-linked invoice was loaded without its order.",
    );
  }
  // SA-1153 G: an invoice has no `estimateId` column (the estimate is a back-relation), so one loaded without it would fall through
  // to its own `createdAt` and a converted quote would change mode at the next re-total. A loader bug: refused, never guessed.
  if (doc && "orderId" in doc && doc.order?.createdAt == null && doc.estimate === undefined) {
    throw new MoneyInvariantError("Discount tax base: an invoice was loaded without its estimate.");
  }
  const at = doc?.order?.createdAt ?? doc?.estimate?.createdAt ?? doc?.createdAt;
  if (at == null) {
    throw new MoneyInvariantError("Discount tax base: the document has no createdAt to read.");
  }
  return discountTaxBaseOf({ createdAt: new Date(at) }, from);
}

/** A document written right now (create, duplicate, standing order, counter sale): its own `createdAt` is now. */
export function newDocumentDiscountMode(now: Date = new Date()): DiscountTaxBase {
  return discountModeOf({ createdAt: now });
}

/**
 * The NSF bounce-fee line is not goods: a PRE_TAX discount never spreads onto it (SA-1141 R1). Stamped on every line
 * a stored-row or draft caller hands the one formula, from the one predicate (`isNsfLine`); a line that already says so keeps it.
 */
export function withNsfFlag<
  T extends { isNsf?: boolean; systemKind?: string | null; description?: string | null },
>(lines: readonly T[]): Array<T & { isNsf: boolean }> {
  return lines.map((l) => ({ ...l, isNsf: l.isNsf ?? isNsfLine(l) }));
}
