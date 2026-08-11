/**
 * Payment-term constants + due-date derivation for the invoice composers.
 * Extracted from app/(operator)/(tabs)/invoices/new.tsx so SplitInvoiceScreen
 * and the invoice edit screen share ONE copy (they had drifted into two).
 * Pure (no RN imports) so __tests__/invoice-terms.test.ts can lock the math.
 */

export const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

export const TERM_OPTIONS = Object.keys(TERM_DAYS);
export const TERM_CHIPS = TERM_OPTIONS.map((label) => ({ label }));
export const DEFAULT_TERMS = "Net 30";
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date = issue date (today when blank) + the term's day count, as web does. */
export function dueDateFor(issueDate: string, terms: string): string {
  const days = TERM_DAYS[terms] ?? 30;
  if (!ISO_DATE.test(issueDate)) return todayPlusDays(days);
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
