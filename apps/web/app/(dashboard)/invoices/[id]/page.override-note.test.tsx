import * as React from "react";
import { screen, renderWithProviders, within } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 510 (SA final pass): on a STAFF invoice, "Sold despite restriction · reason · by · when" belongs to ITS line: it
 * renders inside that line's row, under the product cell, not in another line's row and not as a block under the list.
 */
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
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({ capability: undefined, loading: false }),
}));
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

const item = (id: string, description: string, extra: object = {}) => ({
  id,
  description,
  productId: `p-${id}`,
  qty: 2,
  unitPrice: "5.00",
  subtotal: "10.00",
  discount: "0.00",
  ...extra,
});
const invoice = (items: object[]) => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status: "SENT",
  total: "20.00",
  subtotal: "20.00",
  paidAmount: "0.00",
  balanceDue: "20.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items,
  payments: [],
});
const stamp = {
  restrictionOverrideReason: "Owner approved the sale",
  restrictionOverrideBy: "u-1",
  restrictionOverrideByName: "pat",
  restrictionOverrideAt: "2026-10-07T15:14:00.000Z",
  restrictionOverrideRuleIds: ["r1:CA"],
};

beforeEach(() => seedSession("OPERATOR"));
afterEach(() => seedSession(null));

describe("invoice detail: the override note is part of its own line", () => {
  it("in a two-line invoice with one overridden line the note is inside that line's row only", () => {
    mockInvoice = invoice([item("a", "Widget", stamp), item("b", "Gadget")]);
    renderWithProviders(<InvoiceDetailPage />);
    const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
    expect(rowOf("Widget")).not.toBeNull();
    expect(
      within(rowOf("Widget")).getByText(
        /Sold despite restriction · Owner approved the sale · by pat/,
      ),
    ).toBeInTheDocument();
    expect(within(rowOf("Gadget")).queryByTestId("restriction-override-note")).toBeNull();
    expect(screen.getAllByTestId("restriction-override-note")).toHaveLength(1);
  });

  it("an invoice with no stamped line shows no note", () => {
    mockInvoice = invoice([item("a", "Widget"), item("b", "Gadget")]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("restriction-override-note")).toBeNull();
  });
});
