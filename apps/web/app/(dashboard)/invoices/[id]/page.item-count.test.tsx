import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/** W-1185: the invoice detail foot shows the shared item count. Harness as page.to-collect.test.tsx. */
let mockInvoice: Record<string, unknown>;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/invoices", () => {
  const actual = jest.requireActual("@/lib/api/invoices");
  const idle = () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
  });
  const hooks: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    if (/^use[A-Z]/.test(key)) hooks[key] = idle;
  }
  return {
    ...actual,
    ...hooks,
    useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  };
});
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useUnapplyCreditNote: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomerAdvancePayments: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/use-duplicate-invoice-action", () => ({
  useDuplicateInvoiceAction: () => ({ duplicate: jest.fn() }),
}));

const item = (id: string, over: Record<string, unknown>) => ({
  id,
  description: `Acme ${id}`,
  unitPrice: 1,
  discount: 0,
  subtotal: 1,
  total: 1,
  ...over,
});

const invoice = (items: Array<Record<string, unknown>>) => ({
  id: "inv-1",
  invoiceNumber: "INV-0016",
  status: "SENT",
  subtotal: "3.00",
  total: "3.00",
  paidAmount: "0.00",
  balanceDue: "3.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items,
  payments: [],
});

beforeEach(() => seedSession("OPERATOR"));
afterEach(() => seedSession(null));

describe("invoice detail item count (W-1185)", () => {
  it("a mixed invoice counts lines, boxes, cases and pieces apart at the foot", () => {
    mockInvoice = invoice([
      item("a", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }),
      item("b", { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
      // A plain line counts in its own selling unit (the loaded product's unit).
      item("c", { qty: 6, product: { id: "p1", name: "Acme Rice", unit: "bag" } }),
      item("d", {
        qty: 1.5,
        baseLabel: "bar",
        product: { id: "p2", name: "Acme Tea", unit: "kg" },
      }),
      // The returned-check fee is a system line, not goods.
      item("n", { qty: 1, systemKind: "NSF_FEE" }),
    ]);
    renderWithProviders(<InvoiceDetailPage />);
    const row = screen.getByTestId("invoice-item-count");
    expect(row).toHaveTextContent("Items");
    expect(row).toHaveTextContent("4 lines · 2 boxes · 6 bags · 1 case · 1.5 kg");
  });

  it("reads the builder's count: a plain box line, a named Case line and a plain bag line", () => {
    mockInvoice = invoice([
      item("a", { qty: 1, product: { id: "p1", name: "Acme Tea", unit: "box" } }),
      item("b", { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
      item("c", { qty: 1, product: { id: "p2", name: "Acme Rice", unit: "bag" } }),
    ]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByTestId("invoice-item-count")).toHaveTextContent(
      "3 lines · 1 box · 1 bag · 1 case",
    );
  });

  it("an invoice with no lines reads 0 lines", () => {
    mockInvoice = invoice([]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByTestId("invoice-item-count")).toHaveTextContent("0 lines");
  });
});
