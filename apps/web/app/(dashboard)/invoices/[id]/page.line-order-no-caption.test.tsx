import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * W-1187 R14: the invoice follows the order's line order (the owner's 11-09 answer), so the SA-1071 caption "Listed by product
 * name." is wrong and is gone. The rows are drawn in the order they come; the A to Z order is one tap away (Sort A-Z).
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

const line = (id: string, description: string, subtotal: number) => ({
  id,
  description,
  qty: 1,
  unitPrice: subtotal,
  discount: 0,
  subtotal,
  total: subtotal,
});
const invoiceWith = (items: Array<Record<string, unknown>>) => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status: "SENT",
  subtotal: "20.00",
  total: "20.00",
  paidAmount: "0.00",
  balanceDue: "20.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items,
  payments: [],
});
const CAPTION = "Listed by product name.";

beforeEach(() => seedSession("OPERATOR"));
afterEach(() => seedSession(null));

describe("staff invoice page: the lines are drawn in the order they come", () => {
  it("R14: two or more lines carry no 'Listed by product name.' caption", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 10), line("b", "Acme Chips", 10)]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText(CAPTION)).toBeNull();
  });

  it("the rows are drawn in the order they come (nothing re-sorts them)", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 10), line("b", "Acme Chips", 10)]);
    renderWithProviders(<InvoiceDetailPage />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    const zebra = rows.findIndex((t) => t.includes("Zebra Cola"));
    const acme = rows.findIndex((t) => t.includes("Acme Chips"));
    expect(zebra).toBeGreaterThan(-1);
    expect(acme).toBeGreaterThan(zebra);
  });

  it("a one-line invoice has no caption either", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 20)]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText(CAPTION)).toBeNull();
  });
});
