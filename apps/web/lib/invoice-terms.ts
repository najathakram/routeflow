/**
 * Shared invoice payment-terms helpers, extracted from invoices/new/page.tsx
 * so invoices/[id]/page.tsx's EditTermsModal can share the same due-date
 * arithmetic. Mirrors mobile's `apps/mobile/lib/invoice-terms.ts`.
 */

import { termDays } from "@routeflow/types/payment-terms";

/** Days for a term label, or null when it cannot drive a date: ONE shared table (W-1487), also read by mobile and the API
 *  literal. "Due on Receipt" is 0, "Net N" is N for a whole N from 1 to 365. */
export function getDaysForTerms(terms: string): number | null {
  return termDays(terms);
}

/** Add calendar days to a YYYY-MM-DD date, in UTC end to end. `new Date(iso)`
 *  parses to UTC midnight, so shifting it with the LOCAL getters/setters loses
 *  a day whenever the window crosses a DST start: in America/New_York
 *  2026-03-01 + Net 30 came back as 2026-03-30 instead of 2026-03-31. Mirrors
 *  mobile's `dueDateFor` (apps/mobile/lib/invoice-terms.ts). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
