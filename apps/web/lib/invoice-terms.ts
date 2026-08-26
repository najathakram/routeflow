/**
 * Shared invoice payment-terms helpers, extracted from invoices/new/page.tsx
 * so invoices/[id]/page.tsx's EditTermsModal can share the same due-date
 * arithmetic. Mirrors mobile's `apps/mobile/lib/invoice-terms.ts`.
 */

export function getDaysForTerms(terms: string): number | null {
  switch (terms) {
    case "Due on Receipt":
      return 0;
    case "Net 15":
      return 15;
    case "Net 30":
      return 30;
    case "Net 45":
      return 45;
    case "Net 60":
      return 60;
    default:
      return null;
  }
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
