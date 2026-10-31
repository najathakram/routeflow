import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * SA-1071 V2: SA-1058 sorts invoice lines by printed name on every copy (the owner's 10-30 ruling). The page says so in one
 * caption above the lines. No sort change; the caption is not drawn for a one-line invoice, where there is nothing to sort.
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

describe("staff invoice page: the sort is said once", () => {
  it("V2: two or more lines carry the caption above the table", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 10), line("b", "Acme Chips", 10)]);
    renderWithProviders(<InvoiceDetailPage />);
    const caption = screen.getByText(CAPTION);
    const table = screen.getByRole("table");
    expect(Boolean(caption.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(screen.getAllByText(CAPTION)).toHaveLength(1);
  });

  it("V2: the rows are drawn in the order they come (the caption sorts nothing)", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 10), line("b", "Acme Chips", 10)]);
    renderWithProviders(<InvoiceDetailPage />);
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    const zebra = rows.findIndex((t) => t.includes("Zebra Cola"));
    const acme = rows.findIndex((t) => t.includes("Acme Chips"));
    expect(zebra).toBeGreaterThan(-1);
    expect(acme).toBeGreaterThan(zebra);
  });

  it("V2: a one-line invoice has nothing to say", () => {
    mockInvoice = invoiceWith([line("a", "Zebra Cola", 20)]);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText(CAPTION)).toBeNull();
  });
});
