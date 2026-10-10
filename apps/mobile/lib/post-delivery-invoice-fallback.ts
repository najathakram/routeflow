/**
 * The driver's post-delivery invoice prompt (#2089) has two "can't check the invoice now"
 * exits: the device is offline, or the fetch itself failed. Both show this one message.
 */
export const INVOICE_LATER_TOAST = "Invoice will be ready to send once you're back online.";

interface FallbackDeps {
  toast: (message: string) => void;
  log: (...args: unknown[]) => void;
  proceed: () => void;
}

/**
 * #2251 fold (no silent failure): a failed invoice fetch is logged, told to the driver in
 * the offline path's own words, and never strands them on the completion screen.
 */
export function onPostDeliveryInvoiceFetchFailed(err: unknown, deps: FallbackDeps): void {
  deps.log("[post-delivery-invoice] invoice fetch failed; offering it once online", err);
  deps.toast(INVOICE_LATER_TOAST);
  deps.proceed();
}
