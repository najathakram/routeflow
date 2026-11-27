/**
 * W-1443 (SA-1516): the operator Settings "Send me a copy of invoices I email" switch, bound to the per-user
 * preference `invoiceEmailCopy` (same store and endpoint as `notification-prefs.ts`, which does the network calls).
 * OPT-IN: a missing row reads as OFF and only the exact value "true" is on (the push switch beside it is the
 * opposite, an opt-out). Pure, so it loads under the mobile pure-logic jest.
 */
import { PREF } from "@routeflow/types";

export const INVOICE_COPY_KEY = PREF.invoiceEmailCopy;

/** Pure read: absent (never toggled) is OFF. */
export function invoiceCopyFromPrefs(prefs: Record<string, string> | null | undefined): boolean {
  return prefs?.[INVOICE_COPY_KEY] === "true";
}

/** The patch body the switch writes. */
export function invoiceCopyPatch(enabled: boolean): Record<string, string> {
  return { [INVOICE_COPY_KEY]: enabled ? "true" : "false" };
}
