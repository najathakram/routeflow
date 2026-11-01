import type { InlineReturnQuoteResponse } from "@routeflow/types";
import { formatMoney } from "@/lib/format";

/**
 * SA-1060 A-5: what merging changes about a return taken on a New order, for the merge prompt's one status line.
 *
 * `box` is the return as the Returns box quoted it (priced against the customer's sales as they stand); `merged` is the
 * same request quoted again with `editingOrderId` set to the merge target, i.e. priced after the revert the merge runs
 * (the note's own price). Pure: nothing is read or fetched here and no money is computed, only compared and shown.
 *
 * Returns null when the two agree (the same total and the same never-sold products), so the prompt shows nothing.
 * Otherwise the line names the amount; it ends there unless merging makes a product never-sold that the box had as
 * sold, which also means it is not added to stock.
 */
export function mergeReturnChange(
  box: InlineReturnQuoteResponse,
  merged: InlineReturnQuoteResponse,
): string | null {
  const neverSold = (q: InlineReturnQuoteResponse) =>
    new Set(q.chunks.filter((c) => c.neverSold === true).map((c) => c.productId));
  const before = neverSold(box);
  const after = neverSold(merged);
  const sameNeverSold = before.size === after.size && [...after].every((id) => before.has(id));
  const sameTotal = Math.abs(Number(box.total) - Number(merged.total)) < 0.005;
  if (sameTotal && sameNeverSold) return null;
  const notAdded = [...after].some((id) => !before.has(id));
  return `If you merge, this return is ${formatMoney(merged.total)}${
    notAdded ? ", not added to stock" : ""
  }.`;
}
