import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import EditInvoicePage from "./page";

/**
 * Invoice edit footer: subtotal / tax / total are summed from rounded line totals and the tax is
 * rounded ONCE, exactly as the server stores them. The footer used to sum raw floats, so a tax of
 * 0.7 x 5% = 0.034999999999999996 displayed as $0.03 while the saved invoice stores $0.04.
 */

let mockInvoice: Record<string, unknown> | undefined;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "inv-1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/invoices", () => ({
  useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: undefined }),
  useCustomer: () => ({ data: undefined, isLoading: false }),
  useCustomerPrices: () => ({ data: undefined, isLoading: false }),
}));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: undefined }) }));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const draft = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0001",
  customerId: "c1",
  status: "DRAFT",
  issueDate: "2026-09-20T00:00:00.000Z",
  discount: 0,
  shippingFee: 0,
  items,
  ...extra,
});

const row = (label: string): HTMLElement => {
  const el = screen.getAllByText(label).find((n) => n.tagName === "DT");
  if (!el) throw new Error(`no summary row "${label}"`);
  return el.parentElement as HTMLElement;
};

describe("invoice edit footer — rounded like the server", () => {
  it("rounds a half-cent tax up: $0.70 @ 5% shows Tax $0.04 and Total $0.74 (never $0.03)", () => {
    mockInvoice = draft([
      { id: "li-1", description: "Gum", qty: 1, unitPrice: 0.7, taxRate: 0.05, discount: 0 },
    ]);
    renderWithProviders(<EditInvoicePage />);
    expect(row("Tax")).toHaveTextContent("$0.04");
    expect(row("Total")).toHaveTextContent("$0.74");
  });

  it("a boxed line totals $12.90 in the footer, never $309.60", () => {
    mockInvoice = draft([
      {
        id: "li-2",
        description: "Case of widgets",
        qty: 24,
        boxes: 1,
        pieces: 0,
        unitsPerBox: 24,
        unitPrice: 12.9,
        taxRate: 0,
        discount: 0,
      },
    ]);
    renderWithProviders(<EditInvoicePage />);
    expect(row("Subtotal")).toHaveTextContent("$12.90");
    expect(row("Total")).toHaveTextContent("$12.90");
  });

  it("tax is rounded once over the invoice: two $1.10 lines @ 5% -> Tax $0.11, Total $2.31", () => {
    mockInvoice = draft([
      { id: "li-3", description: "A", qty: 1, unitPrice: 1.1, taxRate: 0.05, discount: 0 },
      { id: "li-4", description: "B", qty: 1, unitPrice: 1.1, taxRate: 0.05, discount: 0 },
    ]);
    renderWithProviders(<EditInvoicePage />);
    expect(row("Tax")).toHaveTextContent("$0.11");
    expect(row("Total")).toHaveTextContent("$2.31");
  });
});
