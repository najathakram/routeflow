import { taxPercentPrecisionError } from "@routeflow/pricing";

/**
 * R5-1 (SA-814 §3, B296): the operator settings screen mirrors web's and the API's cap on the default tax rate: a
 * PERCENT with at most 4 decimals (the 6-dp line fraction). Returns the refusal copy, or null when the text is
 * blank, not a number (the server's own 400 owns that) or within the cap.
 */
export function taxPercentInputError(text: string, stored?: unknown): string | null {
  const t = text.trim();
  // `stored` (review Q5): the tenant's current rate passes unchanged whatever its decimals; only a CHANGED one is capped.
  return t === "" ? null : taxPercentPrecisionError(t, stored);
}
