import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import PaymentDetailPage from "./page";

/**
 * T7 (REG-B80, `.claude/pipeline/2026-09-07-F16-list-caps/bug-test-plan.md`):
 * the payment-receipt page fetches ONE payment by id (`usePaymentDetail`)
 * instead of paging through `useInvoicePayments({ limit: 200 })` and
 * `.find()`-ing the id client-side — a receipt for a payment that isn't in
 * the first 200 rows currently renders "Payment not found." even though the
 * payment exists.
 *
 * TODAY: the page never calls `usePaymentDetail` at all, and calls
 * `useInvoicePayments` unconditionally — so this fails on BOTH assertions
 * below (the spy WAS called; "Payment not found." renders instead of the
 * payment number) rather than on an import/syntax error.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "pay-9" }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

const payment = {
  id: "pay-9",
  paymentNumber: "PAY-000009",
  amount: 42,
  method: "ACH",
  status: "PAID" as const,
  paidAt: "2026-08-26T12:00:00.000Z",
  createdAt: "2026-08-26T12:00:00.000Z",
  invoice: {
    id: "inv-1",
    invoiceNumber: "INV-000001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods" },
  },
};

// The factories below are called WITH arguments by the module mock, so they
// declare parameters — a zero-arity `jest.fn(() => …)` fails `tsc --noEmit`
// with TS2554 / TS2556.
const usePaymentDetailMock = jest.fn((_id: string) => ({ data: payment, isLoading: false }));
const useInvoicePaymentsSpy = jest.fn((..._args: unknown[]) => ({
  data: { data: [], meta: {} },
  isLoading: false,
}));

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  usePaymentDetail: (id: string) => usePaymentDetailMock(id),
  useInvoicePayments: (...args: unknown[]) => useInvoicePaymentsSpy(...args),
  useInvoice: () => ({ data: undefined }),
  useVoidPayment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useGetPaymentImageUrl: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

describe("PaymentDetailPage — REG-B80 single-payment fetch", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fetches the payment by id via usePaymentDetail, never pages useInvoicePayments, and renders the payment number", async () => {
    renderWithProviders(<PaymentDetailPage />);

    expect(await screen.findByText("PAY-000009")).toBeInTheDocument();
    expect(screen.queryByText("Payment not found.")).not.toBeInTheDocument();

    expect(usePaymentDetailMock).toHaveBeenCalledWith("pay-9");
    expect(useInvoicePaymentsSpy).not.toHaveBeenCalled();
  });
});
