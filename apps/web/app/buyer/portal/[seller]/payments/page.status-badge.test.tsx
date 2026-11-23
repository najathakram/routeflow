import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerPayment } from "@routeflow/types";
import Page from "./page";

/**
 * B1151 / SA-1240: the buyer Payments page status cell reads the payment's own status through
 * `paymentRowBadge`: a CASH row is never an empty cell, and a voided check never reads Recorded.
 */
function pay(over: Partial<BuyerPayment>): BuyerPayment {
  return {
    id: "pay-1",
    invoiceId: "inv-1",
    invoiceNumber: "INV-0001",
    amount: 10,
    method: "CASH",
    status: "PAID",
    checkStatus: null,
    nsfFeeAmount: null,
    paidAt: "2026-11-01T12:00:00.000Z",
    ...over,
  };
}

const mockPayments = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    activeSeller: { id: "seller-1", slug: "acme", tenant: { name: "Acme Foods" } },
    isLoading: false,
  }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerPayments: () => mockPayments(),
  useBuyerStatement: () => ({ data: undefined }),
  useBuyerRemittance: () => ({ data: undefined }),
  useBuyerStatementMonths: () => ({ data: undefined }),
}));

jest.mock("./_components/MakePaymentPanel", () => ({ MakePaymentPanel: () => null }));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

const show = (rows: BuyerPayment[]) => {
  mockPayments.mockReturnValue({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
    isLoading: false,
    isError: false,
  });
  renderWithProviders(<Page />);
};

describe("buyer Payments page: the status cell (B1151, SA-1240)", () => {
  it("a CASH PAID row reads Received and a CHECK RECORDED VOID row reads Void", () => {
    show([
      pay({ id: "p1", method: "CASH", status: "PAID" }),
      pay({ id: "p2", method: "CHECK", status: "VOID", checkStatus: "RECORDED" }),
    ]);
    expect(screen.getByText("Received")).toBeInTheDocument();
    expect(screen.getByText("Void")).toBeInTheDocument();
    expect(screen.queryByText("Recorded")).toBeNull();
  });

  it("a bounced check keeps Bounced and its NSF fee line", () => {
    show([
      pay({
        id: "p3",
        method: "CHECK",
        status: "VOID",
        checkStatus: "BOUNCED",
        nsfFeeAmount: 25,
      }),
    ]);
    expect(screen.getByText("Bounced")).toBeInTheDocument();
    expect(screen.getByText(/NSF fee/)).toBeInTheDocument();
  });
});
