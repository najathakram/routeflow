/**
 * Payment-term constants + due-date derivation for the invoice composers.
 * Extracted from app/(operator)/(tabs)/invoices/new.tsx so SplitInvoiceScreen
 * and the invoice edit screen share ONE copy (they had drifted into two).
 * Pure (no RN imports) so __tests__/invoice-terms.test.ts can lock the math.
 */

import { PAYMENT_TERM_PRESETS, netLabel, termDays } from "@routeflow/types/payment-terms";

/** Days for a term label, 30 when it cannot drive a date (as web does). One shared table: W-1487. */
export const daysForTerms = (terms: string): number => termDays(terms) ?? 30;

/** A typed number of days (custom Net N): the label to store, or an inline error for 0, 366, 7.5 and non-numbers. */
export function customTermsFromInput(text: string): { label: string | null; error: string | null } {
  const t = text.trim();
  if (t === "") return { label: null, error: null };
  const label = /^\d+$/.test(t) ? netLabel(Number(t)) : null;
  return label
    ? { label, error: null }
    : { label: null, error: "Enter a whole number of days from 1 to 365." };
}

/** The custom box on commit: a valid number gives its label, anything else keeps the current terms and shows the error. */
export function commitCustomDays(
  text: string,
  currentTerms: string,
): { terms: string; error: string | null } {
  const { label, error } = customTermsFromInput(text);
  return { terms: label ?? currentTerms, error };
}

/** True when the custom box holds text that is not a whole 1-365 (create must not send the old or a partial term). */
export function customDaysBlocksCreate(text: string | undefined): boolean {
  return text !== undefined && customTermsFromInput(text).error !== null;
}

export const TERM_OPTIONS: string[] = [...PAYMENT_TERM_PRESETS];
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
  const days = daysForTerms(terms);
  if (!ISO_DATE.test(issueDate)) return todayPlusDays(days);
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
