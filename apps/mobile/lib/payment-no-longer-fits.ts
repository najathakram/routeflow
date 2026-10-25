import { PAYMENT_NO_LONGER_FITS_COPY } from "@routeflow/types/no-longer-fits-copy";

/**
 * W-769 (SA-910 Part 2 step 4): the invoice screen's flag for an unconfirmed payment that real money displaced. The api derives
 * `noLongerFits` (one predicate); the sentence is the shared constant, so web and mobile cannot drift.
 */
export function noLongerFitsCopy(p: {
  status?: string | null;
  noLongerFits?: boolean;
}): string | null {
  return p.noLongerFits && p.status !== "VOID" ? PAYMENT_NO_LONGER_FITS_COPY : null;
}

/** Void = the EXISTING payment PATCH with status VOID; amount and method are kept because the DTO requires them. */
export function voidPaymentBody(p: { amount: number | string; method: string }) {
  return { amount: Number(p.amount), method: p.method, status: "VOID" as const };
}
