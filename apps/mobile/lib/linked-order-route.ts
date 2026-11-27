/**
 * B1443 (W-1442): one tap from any staff screen that shows a linked order to that order's own
 * screen. Pure, so both the invoice and return detail call the same decision and it is Jest-pinned
 * (__tests__/linked-order-route.test.ts).
 *
 * Every (operator) screen is already reachable only by staff who may open orders (the root layout
 * sends drivers and buyers elsewhere), and the orders screen has no narrower role gate, so there is
 * no extra permission to check here. A document with no linked order returns null: the caller
 * prints nothing, or the number as plain text.
 */

export interface LinkedOrderDoc {
  orderId?: string | null;
  order?: { id?: string | null; orderNumber?: string | null } | null;
}

export interface LinkedOrderTarget {
  id: string;
  /** "Order 1001" (SA-1407 words); "Open order" when the number is not on the payload. */
  label: string;
  route: string;
}

export function linkedOrderTarget(
  doc: LinkedOrderDoc | null | undefined,
): LinkedOrderTarget | null {
  const id = doc?.orderId || doc?.order?.id || null;
  if (!id) return null;
  const number = doc?.order?.orderNumber?.trim();
  return {
    id,
    label: number ? `Order ${number}` : "Open order",
    route: `/(operator)/orders/${id}`,
  };
}
