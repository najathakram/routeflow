/**
 * "Raise a purchase order" on the scan flow (units/PO step 7). The API builds a draft PO from the bill's
 * own lines and links the two: the bill becomes money-only and the PO moves the stock when it is
 * received. It refuses a supplier-less bill or an unmapped line (a PO line without a product can't
 * exist), so the toggle is offered only when those hold.
 */
export function raisePoBlocker(
  supplierId: string,
  items: { productId?: string | null }[],
): string | null {
  if (!supplierId) return "Select a supplier first.";
  if (items.length === 0) return "Add at least one line first.";
  const unmapped = items.filter((i) => !i.productId).length;
  if (unmapped > 0) {
    return `Match ${unmapped === 1 ? "the 1 unmatched line" : `the ${unmapped} unmatched lines`} to a product first.`;
  }
  return null;
}

/**
 * In purchase-order intent the scan exists to draft a PO. If the raise is off or blocked, posting
 * would quietly record (and auto-receive) a bill with NO PO: refuse instead, saying why. Null when
 * the post may go ahead (always null outside purchase-order intent — the bill flow is unchanged).
 */
export function poIntentRefusal(
  intent: "bill" | "purchase-order",
  raisePo: boolean,
  blocker: string | null,
  createMode: "bill" | "expense" | "both" = "bill",
): string | null {
  if (intent !== "purchase-order") return null;
  if (createMode !== "bill") {
    return "A purchase-order scan records only a bill and its PO.";
  }
  if (!raisePo)
    return "Turn on “Raise a purchase order” — this scan creates a PO, not just a bill.";
  if (blocker) return `Can't draft the purchase order yet: ${blocker}`;
  return null;
}

/** The note shown after a scan-created bill that raised a PO — stock waits for the PO's receipt. */
export const RAISED_PO_NOTE =
  "Draft purchase order raised — receive it to update inventory (the bill itself doesn't move stock)";
