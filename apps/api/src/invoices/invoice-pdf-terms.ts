import { isPaidAtSale, termsAndConditionsToShow } from "@routeflow/pricing";
import type { PaidAtSaleInvoice } from "@routeflow/pricing";

/**
 * Row 401: what the invoice PDF prints for payment terms. A counter sale paid at the till (the SAME `isPaidAtSale` rule the
 * invoice page and the e-mail follow) has no Due Date and no Terms line, and a "Terms & Conditions" text that is only the
 * payment terms is dropped; every other invoice prints both and its T&C text as stored. Display only.
 */
export function pdfTermsView(
  inv: PaidAtSaleInvoice & { terms?: unknown; paymentTermsLabel?: string | null },
): { showDueAndTerms: boolean; termsAndConditions: string | null } {
  return {
    showDueAndTerms: !isPaidAtSale(inv),
    termsAndConditions: termsAndConditionsToShow(inv),
  };
}
