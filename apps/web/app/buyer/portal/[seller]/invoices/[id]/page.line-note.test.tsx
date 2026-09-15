import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * WP2 — R5.8: the buyer invoice detail page renders each line item's
 * buyer-visible `notes` (e.g. flavor) under the description cell, styled
 * `mt-0.5 text-xs font-normal italic text-navy/60` (ruling HL-3 / ux-spec
 * anatomy). A `null`/absent note renders nothing extra for that line.
 */
function makeInvoice(overrides: Partial<BuyerInvoiceDetail> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    subtotal: 20,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 20,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items: [
      {
        id: "item-1",
        description: "Mango Juice",
        productId: "p1",
        qty: 1,
        unitPrice: 10,
        discount: 0,
        subtotal: 10,
        priceType: "STANDARD",
        notes: "Mango",
      },
      {
        id: "item-2",
        description: "Orange Juice",
        productId: "p2",
        qty: 1,
        unitPrice: 10,
        discount: 0,
        subtotal: 10,
        priceType: "STANDARD",
        notes: null,
      },
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
    ...overrides,
  };
}

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: makeInvoice(),
  isLoading: false,
  isError: false,
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "seller-1", slug: "acme" }, isLoading: false }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: (...args: unknown[]) => mockUseBuyerInvoice(...args),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

describe("buyer invoice detail — per-line note (R5.8)", () => {
  beforeEach(() => {
    mockUseBuyerInvoice.mockReturnValue({ data: makeInvoice(), isLoading: false, isError: false });
  });

  it("renders a note italic under the description for the line that has one", () => {
    renderWithProviders(<Page />);
    const noteEl = screen.getByText("Mango");
    expect(noteEl.className).toEqual(expect.stringContaining("italic"));
  });

  it("renders exactly one note paragraph — the null-note line renders nothing extra", () => {
    renderWithProviders(<Page />);
    const notes = document.querySelectorAll("p.italic");
    expect(notes.length).toBe(1);
  });
});
