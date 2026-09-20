/**
 * Read-only surface for jurisdiction selling restrictions (LANE-R step 6, mobile half). Pure logic:
 * parse the server's 409 and turn it into operator-facing copy. Mobile never evaluates or edits a
 * rule — it only explains why the server refused a sale.
 *
 * Contract: `SellingRestrictedError` / `BlockedLine` / `RestrictedProductChip` in
 * `@routeflow/types` (packages/types/api/restrictions.ts). The API's enforcement choke point (a 409
 * `SELLING_RESTRICTED`) is a later Lane R step; this parser is inert until the server emits it, and
 * mirrors `parseRegulatedAuthError`'s shape so both blocks read the same way.
 */
import type { BlockedLine } from "@routeflow/types";

/**
 * Detects the server's selling-restriction block. Returns the blocked lines (possibly empty for a
 * malformed body), or null when this isn't a SELLING_RESTRICTED 409.
 */
export function parseSellingRestrictedError(err: unknown): BlockedLine[] | null {
  const res = (
    err as {
      response?: { status?: number; data?: { code?: string; blockedLines?: unknown } };
    }
  )?.response;
  if (res?.status !== 409 || res.data?.code !== "SELLING_RESTRICTED") return null;
  const lines = res.data.blockedLines;
  if (!Array.isArray(lines)) return [];
  // The body is server-controlled but untrusted: keep only object entries, and coerce the
  // fields the copy reads to strings so a malformed entry can never throw inside the alert path.
  return lines
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      ...(l as unknown as BlockedLine),
      productId: String(l.productId ?? ""),
      productName: String(l.productName ?? "An item"),
      message: typeof l.message === "string" ? l.message : "",
    }));
}

/**
 * One line's explanation. The server's own `message` is authoritative (it knows the rule's reason
 * and effective window); the per-reason fallback only covers a body that arrived without one.
 */
export function describeBlockedLine(line: BlockedLine): string {
  const message = typeof line.message === "string" ? line.message.trim() : "";
  if (message) return message;
  switch (line.reason) {
    case "FEDERAL_BAN":
      return "Restricted by federal rule";
    case "STATE_BAN":
      return line.state ? `Restricted in ${line.state}` : "Restricted in this customer's state";
    case "BUYER_PORTAL_ONLY":
      return "Not sold through the buyer portal";
    case "INDETERMINATE_ADDRESS":
      return "This customer's state isn't on file";
    case "UNKNOWN_PRODUCT":
      return "Product not found";
    default:
      return "Can't be sold to this customer";
  }
}

export interface RestrictedBlockSummary {
  title: string;
  body: string;
}

/**
 * The alert for a blocked save. Duplicate products collapse to one entry (the server already does
 * this; a repeat here would only read as noise). When EVERY entry is an unresolved-address failure
 * the fix is the customer's address, not the products, so that gets its own plain-language title —
 * the feature fails closed, and the operator must be told why rather than left guessing.
 */
export function summarizeRestrictedBlock(lines: readonly BlockedLine[]): RestrictedBlockSummary {
  const seen = new Set<string>();
  const unique = lines.filter((l) => {
    if (seen.has(l.productId)) return false;
    seen.add(l.productId);
    return true;
  });

  if (unique.length === 0) {
    return { title: "Can't sell this to the customer", body: "A selling restriction applies." };
  }

  if (unique.every((l) => l.reason === "INDETERMINATE_ADDRESS")) {
    return {
      title: "Can't check what this customer can buy",
      body:
        "This customer's state isn't on file, so restricted products can't be checked. " +
        "Add a default address with a state, then try again.",
    };
  }

  const n = unique.length;
  return {
    title: `${n} item${n === 1 ? "" : "s"} can't be sold to this customer`,
    body: unique.map((l) => `• ${l.productName}: ${describeBlockedLine(l)}`).join("\n"),
  };
}
