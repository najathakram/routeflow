import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { InvoicePreviewModal, OrderPreviewModal } from "./LinkedDocPreviewModal";

/**
 * Row 398: the staff preview shows the regular tax and each regulated charge as their own rows, the same lines the
 * invoice PDF prints: never the deposit / excise inside "Tax", never a bare gap between Subtotal + Tax and the total.
 */
const ALL_CATEGORIES = [
  { id: "cat-crv", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER", active: true },
  { id: "cat-tob", name: "Tobacco", taxType: "EXCISE_PER_UNIT", active: true },
];

let categories: unknown[] = ALL_CATEGORIES;
let invoice: Record<string, unknown> | undefined;
let order: Record<string, unknown> | undefined;
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoice: () => ({ data: invoice, isLoading: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrder: () => ({ data: order, isLoading: false }),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  ...jest.requireActual("@/lib/api/tracked-categories"),
  useTrackedCategories: () => ({ data: categories }),
}));

const row = (label: string) => screen.getByText(label).closest("div")!;

describe("InvoicePreviewModal", () => {
  beforeEach(() => {
    categories = ALL_CATEGORIES;
    invoice = {
      id: "inv-1",
      invoiceNumber: "INV-1",
      subtotal: 31.48,
      taxAmount: 5.4,
      total: 36.88,
      paidAmount: 36.88,
      balanceDue: 0,
      items: [
        {
          id: "i1",
          description: "Soda",
          qty: 4,
          unitPrice: 7.87,
          subtotal: 31.48,
          trackedCategoryId: "cat-crv",
          categoryTaxAmount: "2.80",
          categoryTaxType: "DEPOSIT_PER_CONTAINER",
        },
      ],
    };
  });

  it("Tax is the regular 2.60 and the deposit is its own 'CRV deposit' row of 2.80", () => {
    renderWithProviders(<InvoicePreviewModal open onClose={() => undefined} invoiceId="inv-1" />);
    expect(row("Tax")).toHaveTextContent("$2.60");
    expect(row("CRV deposit")).toHaveTextContent("$2.80");
    expect(row("Invoice total")).toHaveTextContent("$36.88");
  });

  it("names the charge from the category row on the line itself before the categories list has answered", () => {
    categories = [];
    invoice = {
      ...invoice,
      items: [
        {
          id: "i1",
          description: "Soda",
          qty: 4,
          unitPrice: 7.87,
          subtotal: 31.48,
          trackedCategoryId: "cat-crv",
          categoryTaxAmount: "2.80",
          categoryTaxType: null, // billed before the snapshot column existed
          trackedCategory: { id: "cat-crv", name: "CRV", taxType: "DEPOSIT_PER_CONTAINER" },
        },
      ],
    };
    renderWithProviders(<InvoicePreviewModal open onClose={() => undefined} invoiceId="inv-1" />);
    expect(row("CRV deposit")).toHaveTextContent("$2.80");
  });

  it("an invoice with no levy keeps its whole header as Tax and adds no charge row", () => {
    invoice = {
      ...invoice,
      taxAmount: 2.6,
      total: 34.08,
      items: [{ id: "i1", description: "Water", qty: 4, unitPrice: 7.87, subtotal: 31.48 }],
    };
    renderWithProviders(<InvoicePreviewModal open onClose={() => undefined} invoiceId="inv-1" />);
    expect(row("Tax")).toHaveTextContent("$2.60");
    expect(screen.queryByText("CRV deposit")).toBeNull();
  });
});

describe("OrderPreviewModal", () => {
  it("shows the order's levy as a named row so Subtotal + Tax + charges = Order total", () => {
    order = {
      id: "o-1",
      orderNumber: "ORD-1",
      status: "PENDING",
      subtotal: 31.48,
      tax: 2.6,
      total: 36.88,
      invoices: [],
      lineItems: [
        {
          id: "l1",
          name: "Soda",
          qty: 4,
          unitPrice: 7.87,
          subtotal: 31.48,
          status: "PENDING",
          trackedCategoryId: "cat-crv",
          categoryTaxAmount: "2.80",
        },
      ],
    };
    renderWithProviders(<OrderPreviewModal open onClose={() => undefined} orderId="o-1" />);
    expect(row("Tax")).toHaveTextContent("$2.60");
    expect(row("CRV deposit")).toHaveTextContent("$2.80");
    expect(row("Order total")).toHaveTextContent("$36.88");
  });
});
