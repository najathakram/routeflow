import * as React from "react";
import { fireEvent } from "@testing-library/react";
import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * SA-1148 case 12: "Pay this invoice" carries the invoice it was pressed on, so the payments page (and the
 * server) pay THAT invoice first instead of the oldest one.
 */
const push = jest.fn();

function makeInvoice(): BuyerInvoiceDetail {
  return {
    id: "inv-b",
    invoiceNumber: "INV-0002",
    status: "SENT",
    subtotal: 100,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 100,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-02-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items: [
      invoiceItem({
        id: "item-1",
        description: "Widget",
        productId: "p1",
        qty: 1,
        unitPrice: 100,
        discount: 0,
        subtotal: 100,
        priceType: "STANDARD",
      }),
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
  };
}

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-b" }),
  useRouter: () => ({ push }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "seller-1", slug: "acme" }, isLoading: false }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: () => ({ data: makeInvoice(), isLoading: false, isError: false }),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

describe("buyer invoice detail: Pay this invoice (SA-1148)", () => {
  it("opens the payments page with the amount and this invoice's id", () => {
    renderWithProviders(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Pay $100.00" }));
    expect(push).toHaveBeenCalledWith("/buyer/portal/acme/payments?amount=100.00&invoiceId=inv-b");
  });
});
