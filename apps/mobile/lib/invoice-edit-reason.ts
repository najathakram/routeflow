/**
 * H3b: the invoice EDIT screen's price-change reason. The server judges a CHANGED price on a product
 * line against the customer's tier price (a special price needs a reason; its 400 reaches the save
 * alert), and keeps a re-sent stored price as it was. So the screen shows the Reason field — and sends
 * the reason — only for a product line whose price moved off the price it was offered at, or one
 * added on this screen (offered at the catalog list, which the server may judge against a tier price).
 */
export interface ReasonLine {
  productId: string | null;
  unitPrice: number | null;
  /** The stored price on load; absent on a line added here. */
  offeredPrice?: number;
  overrideReason?: string;
}

export const showsReason = (l: ReasonLine): boolean =>
  !!l.productId &&
  (l.offeredPrice == null || Math.abs((l.unitPrice ?? 0) - l.offeredPrice) >= 0.005);

/** `{ overrideReason }` (trimmed) when the field is showing and filled; nothing otherwise. */
export const reasonField = (l: ReasonLine): { overrideReason?: string } => {
  const reason = l.overrideReason?.trim();
  return showsReason(l) && reason ? { overrideReason: reason } : {};
};
