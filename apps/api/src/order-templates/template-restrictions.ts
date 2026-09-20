import type { BlockedLine, RestrictionsEvaluation } from "@routeflow/types";

/**
 * Selling restrictions at `OrderTemplatesService.createOrderFromTemplate` (lane R, standing orders).
 * PURE: the service asks the choke point (`checkLinesSellable`) and hands the answer here.
 *
 * A standing order is skip-and-notify, never hard-fail (plan §3 #6, the same shape as the regulated
 * license guard): a BLOCK / INDETERMINATE line is DROPPED and the rest is still ordered, so one
 * banned product cannot stop a customer's whole weekly order. FAIL CLOSED: a BLOCK / INDETERMINATE
 * outcome that names no product drops EVERY line — never an unexplained pass. OFF and ALLOW drop
 * nothing.
 */
export function splitRestrictedLines<T extends { productId: string }>(
  items: readonly T[],
  evaluation: RestrictionsEvaluation,
): { allowed: T[]; blocked: BlockedLine[] } {
  if (evaluation.outcome !== "BLOCK" && evaluation.outcome !== "INDETERMINATE") {
    return { allowed: [...items], blocked: [] };
  }
  const named = new Set(evaluation.reasons.map((r) => r.productId));
  const unexplained = named.size === 0;
  return {
    allowed: unexplained ? [] : items.filter((i) => !named.has(i.productId)),
    blocked: evaluation.reasons,
  };
}
