import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { MakePaymentPanel } from "./MakePaymentPanel";

/**
 * SA-1148: the panel sends the chosen invoice with the card request and the preview, and drops a stale target
 * (an invoice that is no longer open) so a Back-button or bookmarked link cannot dead-end on a 400.
 */
const mutate = jest.fn();
const cashMutate = jest.fn();
const previewHook = jest.fn((..._args: unknown[]) => ({ data: undefined, isFetching: false }));

const line = (invoiceId: string, invoiceNumber: string) => ({
  invoiceId,
  invoiceNumber,
  issueDate: "2026-01-01",
  total: 100,
  balanceDue: 100,
  applied: 0,
});

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "s", slug: "acme", tenant: { name: "Acme" } } }),
}));

jest.mock("@/lib/api/buyer-payments", () => ({
  useBuyerPaymentContext: () => ({
    data: {
      balanceDue: 200,
      cardEnabled: true,
      openInvoices: [line("inv-a", "INV-A"), line("inv-b", "INV-B")],
      pendingRequests: [],
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerPaymentPreview: (...args: unknown[]) => previewHook(...args),
  useStartCardPayment: () => ({ mutate, isPending: false }),
  useDeclareCashPayment: () => ({ mutate: cashMutate, isPending: false }),
  useCancelPaymentRequest: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

describe("MakePaymentPanel chosen invoice (SA-1148)", () => {
  beforeEach(() => {
    mutate.mockReset();
    cashMutate.mockReset();
    previewHook.mockClear();
    previewHook.mockReturnValue({ data: undefined, isFetching: false });
  });

  it("sends the chosen invoice with the card request and the preview", () => {
    renderWithProviders(<MakePaymentPanel defaultAmount={100} fromInvoiceId="inv-b" />);
    fireEvent.click(screen.getByText("Pay by card"));
    expect(mutate.mock.calls[0][0]).toEqual({ amount: 100, fromInvoiceId: "inv-b" });
    expect(previewHook).toHaveBeenLastCalledWith(100, "inv-b");
  });

  it("sends the chosen invoice with a declared cash payment", () => {
    renderWithProviders(<MakePaymentPanel defaultAmount={100} fromInvoiceId="inv-b" />);
    fireEvent.click(screen.getByText("I've paid cash"));
    fireEvent.click(screen.getByText("Confirm I've paid $100.00"));
    expect(cashMutate.mock.calls[0][0]).toMatchObject({ amount: 100, fromInvoiceId: "inv-b" });
  });

  it("the preview reads 'This pays invoice {number} first.' in place of the oldest-first line", () => {
    previewHook.mockReturnValue({
      data: { lines: [{ ...line("inv-b", "INV-B"), applied: 100 }], excess: 0 },
      isFetching: false,
    } as any);
    renderWithProviders(<MakePaymentPanel defaultAmount={100} fromInvoiceId="inv-b" />);
    expect(screen.getByText("This pays invoice INV-B first.")).toBeInTheDocument();
    expect(screen.queryByText("Payments are applied to your oldest invoices first.")).toBeNull();
  });

  it("guard: without a chosen invoice the oldest-first line stays and no target is sent", () => {
    renderWithProviders(<MakePaymentPanel defaultAmount={100} />);
    expect(
      screen.getByText("Payments are applied to your oldest invoices first."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Pay by card"));
    expect(mutate.mock.calls[0][0]).toEqual({ amount: 100, fromInvoiceId: undefined });
  });

  it("drops a chosen invoice that is no longer open", () => {
    renderWithProviders(<MakePaymentPanel defaultAmount={100} fromInvoiceId="inv-gone" />);
    fireEvent.click(screen.getByText("Pay by card"));
    expect(mutate.mock.calls[0][0]).toEqual({ amount: 100, fromInvoiceId: undefined });
  });
});
