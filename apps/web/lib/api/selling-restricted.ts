import type { BlockedLine, RestrictionReason } from "@routeflow/types";

/**
 * The 409 `{ code: "SELLING_RESTRICTED", blockedLines }` the API's selling-restrictions choke point
 * throws when an order line may not be sold to this customer. Returns the blocked lines (never an
 * empty list for a matching error: a detail-less refusal yields one generic line), or null for any other error. Mirrors `parseRegulatedAuthError`.
 */
export function parseSellingRestricted(err: unknown): BlockedLine[] | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; blockedLines?: BlockedLine[] };
      };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "SELLING_RESTRICTED") return null;
  const lines = res.data.blockedLines;
  if (lines && lines.length > 0) return lines;
  // The code is suppressed from the global toast, so a refusal with no detail must still say
  // something: one generic line, never an empty dialog.
  return [
    {
      productId: "",
      productName: "An item on this order",
      ruleId: null,
      reason: "UNKNOWN_PRODUCT",
      message: "",
    },
  ];
}

/** Plain-language cause for one blocked line (never a raw enum or id). */
export function restrictionReasonText(line: Pick<BlockedLine, "reason" | "state">): string {
  const where = line.state ? ` in ${line.state}` : "";
  const byReason: Record<RestrictionReason, string> = {
    FEDERAL_BAN: "Restricted by federal law",
    STATE_BAN: `Restricted${where}`,
    BUYER_PORTAL_ONLY: "Not available for online ordering",
    INDETERMINATE_ADDRESS:
      "We can't tell where this customer is. Set a default address with a state, then try again",
    UNKNOWN_PRODUCT: "This item couldn't be checked, so it can't be sold right now",
    HIDDEN_FROM_PORTAL: "Not available for online ordering",
  };
  return byReason[line.reason] ?? "Restricted";
}

/**
 * What a BUYER sees when their cart is refused: the item names only (no rule, state or category
 * detail — that is for staff). Duplicates collapse. Lines with no usable name (including the
 * parser's detail-less placeholder) are counted, not dropped, so the buyer is never told fewer
 * items are blocked than really are; with no names at all it falls back to a generic line.
 */
export function buyerBlockedMessage(
  lines: Pick<BlockedLine, "productId" | "productName">[],
): string {
  const named = lines.filter((l) => l.productName && l.productId);
  const names = Array.from(new Set(named.map((l) => l.productName)));
  if (names.length === 0) {
    return "Some items in your cart can't be ordered right now. Remove them and try again.";
  }
  const unnamed = lines.length - named.length;
  const more = unnamed > 0 ? ` and ${unnamed} other item${unnamed === 1 ? "" : "s"}` : "";
  return `Some items can't be ordered right now: ${names.join(", ")}${more}. Remove them from your cart and try again.`;
}
