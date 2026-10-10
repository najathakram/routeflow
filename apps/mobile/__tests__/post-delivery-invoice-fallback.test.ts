import {
  INVOICE_LATER_TOAST,
  onPostDeliveryInvoiceFetchFailed,
} from "../lib/post-delivery-invoice-fallback";

/**
 * #2251 fold (tier 2, no silent failure): when the post-delivery invoice fetch fails, the
 * driver sees the SAME "back online" toast as the offline path, the failure is logged, and
 * the driver still moves on — the old `.catch(() => proceedToRoute())` swallowed it silently.
 */
describe("onPostDeliveryInvoiceFetchFailed (#2251)", () => {
  const run = (err: unknown) => {
    const toast = jest.fn();
    const log = jest.fn();
    const proceed = jest.fn();
    onPostDeliveryInvoiceFetchFailed(err, { toast, log, proceed });
    return { toast, log, proceed };
  };

  it("shows the offline toast, word for word", () => {
    const { toast } = run(new Error("Network Error"));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(INVOICE_LATER_TOAST);
    expect(INVOICE_LATER_TOAST).toBe("Invoice will be ready to send once you're back online.");
  });

  it("logs the failure with its cause", () => {
    const err = new Error("503");
    const { log } = run(err);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toContain(err);
  });

  it("still moves the driver on, after the toast", () => {
    const order: string[] = [];
    onPostDeliveryInvoiceFetchFailed("boom", {
      toast: () => order.push("toast"),
      log: () => order.push("log"),
      proceed: () => order.push("proceed"),
    });
    expect(order).toEqual(["log", "toast", "proceed"]);
  });
});
