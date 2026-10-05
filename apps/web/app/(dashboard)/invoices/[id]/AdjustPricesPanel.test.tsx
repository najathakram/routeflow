/**
 * B1058 (SA-683): the bulk price adjustment can end in two structured refusals the operator must be able to
 * act on, and the panel used to show both as "Failed to adjust prices" with the server's raw sentence:
 *   - 409 PRICE_ADJUSTMENT_PARTIAL: some invoices committed. The panel shows what was updated, what was
 *     refused or failed its order sync, what was never attempted, and the invoice queries are invalidated
 *     (the page holds stale data otherwise).
 *   - 400 PRICE_ADJUSTMENT_OVERPAYS: nothing was written; the list of invoices the change would overpay.
 * Both are rendered from FIXED copy built from structured body fields (B980), never `body.message`, and as
 * ONE toast (the panel's own: the global handler is told to skip them), same contract as one-toast.test.tsx.
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { handleMutationError } from "@/lib/mutation-error-toast";
import { AdjustPricesPanel } from "./AdjustPricesPanel";

const toast = jest.fn();
const post = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a) },
}));

const RAW = "RAW-SERVER-SENTENCE-DO-NOT-RENDER";
const invoice: any = {
  id: "inv-1",
  customer: { businessName: "Acme Foods" },
  items: [{ id: "l1", description: "Widget", qty: 1, unitPrice: 50 }],
};

const reject = (status: number, data: object) =>
  post.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

/** The app's real global error handler on a client the test can spy on (app/providers.tsx wires the same one). */
function setup() {
  const client = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation as any, toast, { push: jest.fn() }),
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const onClose = jest.fn();
  render(
    <QueryClientProvider client={client}>
      <AdjustPricesPanel invoice={invoice} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { invalidate, onClose };
}
const applyBulk = () => {
  fireEvent.click(screen.getByLabelText(/All invoices for/));
  fireEvent.click(screen.getByRole("button", { name: /Apply Price Changes/ }));
};
/** SINGLE is the panel's default scope: no radio click, straight to Apply. */
const applySingle = () =>
  fireEvent.click(screen.getByRole("button", { name: /Apply Price Changes/ }));
const invalidatedInvoices = (spy: jest.SpyInstance) =>
  spy.mock.calls.some(
    ([f]) => JSON.stringify((f as any)?.queryKey) === JSON.stringify(["invoices"]),
  );

beforeEach(() => jest.clearAllMocks());

describe("AdjustPricesPanel failure display (B1058)", () => {
  it("409 PARTIAL with a refused invoice: the summary, ONE toast, the invoice queries invalidated, the panel stays open", async () => {
    reject(409, {
      code: "PRICE_ADJUSTMENT_PARTIAL",
      message: RAW,
      applied: ["a", "b"],
      refused: {
        invoiceId: "c",
        invoiceNumber: "INV-3",
        code: "INVOICE_CHANGED_CONCURRENTLY",
        message: RAW,
      },
      skipped: ["d", "e"],
    });
    const { invalidate, onClose } = setup();
    applyBulk();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prices partly updated");
    expect(alert).toHaveTextContent("2 invoices were updated");
    expect(alert).toHaveTextContent("INV-3 changed while saving and was not updated");
    expect(alert).toHaveTextContent("2 invoices were not attempted");
    expect(alert).toHaveTextContent("apply the change again");
    expect(document.body).not.toHaveTextContent(RAW);
    expect(document.body).not.toHaveTextContent("Failed to adjust prices");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Prices partly updated");
    expect(invalidatedInvoices(invalidate)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("409 PARTIAL after a post-commit sync failure: that invoice is named as updated, with its order to check", async () => {
    reject(409, {
      code: "PRICE_ADJUSTMENT_PARTIAL",
      message: RAW,
      applied: ["a", "b"],
      syncFailed: { invoiceId: "b", invoiceNumber: "INV-2" },
      skipped: ["c"],
    });
    const { invalidate } = setup();
    applyBulk();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("2 invoices were updated");
    expect(alert).toHaveTextContent("INV-2 was updated, but its follow-up sync did not finish");
    expect(alert).toHaveTextContent("order totals and commissions may be out of date");
    expect(alert).toHaveTextContent("1 invoice was not attempted");
    expect(document.body).not.toHaveTextContent(RAW);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(invalidatedInvoices(invalidate)).toBe(true);
  });

  it("409 PARTIAL whose refusal is the overpayment re-judge says so, and a hostile invoice number is not rendered", async () => {
    reject(409, {
      code: "PRICE_ADJUSTMENT_PARTIAL",
      message: RAW,
      applied: ["a"],
      refused: {
        invoiceId: "b",
        invoiceNumber: "<img src=x onerror=alert(1)>",
        code: "PRICE_ADJUSTMENT_OVERPAYS",
        message: RAW,
      },
      skipped: [],
    });
    setup();
    applyBulk();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 invoice was updated");
    expect(alert).toHaveTextContent("One invoice would now be overpaid");
    expect(alert).toHaveTextContent("credit note");
    expect(alert).not.toHaveTextContent("onerror");
  });

  it("400 OVERPAYS: every offending invoice with its amount, ONE toast, nothing invalidated (nothing was written)", async () => {
    reject(400, {
      code: "PRICE_ADJUSTMENT_OVERPAYS",
      message: RAW,
      overpaid: [
        { invoiceId: "x", invoiceNumber: "INV-2", paid: 40, newTotal: 20, overpaidBy: 20 },
        { invoiceId: "y", invoiceNumber: "INV-4", paid: 25, newTotal: 20, overpaidBy: 5 },
      ],
    });
    const { invalidate, onClose } = setup();
    applyBulk();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prices not changed");
    expect(alert).toHaveTextContent("would leave 2 invoices overpaid");
    expect(alert).toHaveTextContent("INV-2 would be overpaid by $20.00");
    expect(alert).toHaveTextContent("INV-4 would be overpaid by $5.00");
    expect(alert).toHaveTextContent("credit note");
    expect(document.body).not.toHaveTextContent(RAW);
    expect(document.body).not.toHaveTextContent("Failed to adjust prices");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].title).toBe("Prices not changed");
    expect(invalidatedInvoices(invalidate)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("SINGLE scope 400 with ONE overpaid entry reads as one invoice, never '0 invoices'", async () => {
    reject(400, {
      code: "PRICE_ADJUSTMENT_OVERPAYS",
      message: RAW,
      overpaid: [
        { invoiceId: "x", invoiceNumber: "INV-9", paid: 100, newTotal: 80, overpaidBy: 20 },
      ],
    });
    const { invalidate } = setup();
    applySingle();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prices not changed");
    expect(alert).toHaveTextContent("Invoice INV-9 would be overpaid by $20.00");
    expect(alert).toHaveTextContent("Issue a credit note instead");
    expect(alert).not.toHaveTextContent(/0 invoices|1 invoices/);
    expect(document.body).not.toHaveTextContent(RAW);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(invalidatedInvoices(invalidate)).toBe(false);
  });

  it.each([
    ["no list at all", {}],
    ["an empty list", { overpaid: [] }],
  ])("400 OVERPAYS with %s: a safe generic line, never '0 invoices'", async (_n, extra) => {
    reject(400, { code: "PRICE_ADJUSTMENT_OVERPAYS", message: RAW, ...extra });
    setup();
    applySingle();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Prices not changed");
    expect(alert).toHaveTextContent("This change would leave an invoice overpaid");
    expect(alert).toHaveTextContent("Issue a credit note instead");
    expect(alert).not.toHaveTextContent(/\b0 invoices/);
    expect(document.body).not.toHaveTextContent(RAW);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("any other failure keeps today's behaviour: the panel's own 'Failed to adjust prices' toast with the server sentence", async () => {
    reject(400, {
      message: "Invoice INV-1: Invoice discount ($30.00) cannot exceed subtotal ($20.00).",
    });
    setup();
    applyBulk();

    await waitFor(() =>
      expect(toast.mock.calls.map((c) => c[0].title)).toContain("Failed to adjust prices"),
    );
    const own = toast.mock.calls.find((c) => c[0].title === "Failed to adjust prices")![0];
    expect(own.description).toContain("cannot exceed subtotal");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("success: the success toast and the panel closes", async () => {
    post.mockResolvedValueOnce({ data: { id: "inv-1" } });
    const { onClose } = setup();
    applyBulk();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].title).toBe("Prices updated");
  });
});
