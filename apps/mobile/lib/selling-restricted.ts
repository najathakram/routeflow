/**
 * Pure helpers for the 409 SELLING_RESTRICTED block (no api-client import, so unit-testable without
 * RN). Mirrors apps/web/lib/api/selling-restricted.ts — keep the reason copy identical.
 */
import type { BlockedLine, RestrictionReason } from "@routeflow/types";

/**
 * The 409 `{ code: "SELLING_RESTRICTED", blockedLines }` the API's selling-restrictions choke point
 * throws when an order line may not be sold to this customer. Returns the blocked lines (never an
 * empty list for a matching error), or null for any other error. Mirrors `parseRegulatedAuthError`.
 */
export function parseSellingRestricted(err: unknown): BlockedLine[] | null {
  const res = (
    err as {
      response?: { status?: number; data?: { code?: string; blockedLines?: BlockedLine[] } };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "SELLING_RESTRICTED") return null;
  return res.data.blockedLines ?? [];
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
