import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 342: the invoice header shows where and by whom the linked order was handed over, from the order stub the staff read
 * carries. Staff sessions only.
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

const invoice = (order?: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0014",
  status: "PAID",
  total: "35.00",
  paidAmount: "35.00",
  balanceDue: "0.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
  orderId: "o1",
  ...(order ? { order } : {}),
  ...over,
});
const HANDED = {
  status: "DELIVERED",
  orderNumber: "ORD-9",
  fulfillPath: "PICKUP",
  registerKey: "main",
  handedOverBy: "Pat",
  soldBy: { username: "Pat" },
};

afterEach(() => seedSession(null));

describe("invoice header hand-over stamp (row 342)", () => {
  it("staff see the register and the cashier", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(HANDED);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent("Handed over by Pat · main");
  });
  it("an order with no stamped register (delivered from the office) shows no stamp", () => {
    seedSession("TENANT_ADMIN");
    mockInvoice = invoice({ ...HANDED, registerKey: null, handedOverBy: null, soldBy: null });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
  it("a customer session never sees it", () => {
    seedSession("CUSTOMER");
    mockInvoice = invoice(HANDED);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
  it("no stamp on the order stub (an older API, or a delivery order): nothing", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice({ status: "DELIVERED", orderNumber: "ORD-9", fulfillPath: "PICKUP" });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("hand-over-stamp")).toBeNull();
  });
});

// CQ-26: a counter sale paid at the till is settled when rung, so its invoice shows no terms and no due date.
describe("invoice terms and due date on a counter sale paid at the till (CQ-26)", () => {
  const TERMS = {
    dueDate: "2026-10-01T00:00:00.000Z",
    paymentTermsLabel: "Net 30",
    createdAt: "2026-09-01T15:00:00.000Z",
  };
  const COUNTER = {
    status: "DELIVERED",
    orderNumber: "ORD-9",
    counterSale: true,
    registerKey: "main",
  };
  const PAID_AT_SALE = [
    { id: "p1", method: "CASH", amount: "35.00", createdAt: "2026-09-01T15:00:03.000Z" },
  ];

  it("hides Net 30 and the due date when the till took the money", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(COUNTER, { ...TERMS, payments: PAID_AT_SALE });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText("Net 30")).toBeNull();
    expect(screen.queryByText("Due Date:")).toBeNull();
    expect(screen.queryByText(/· due /)).toBeNull();
  });
  it("the Terms & Conditions row that only repeats 'Net 30' goes too; a real T&C text stays", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(COUNTER, { ...TERMS, terms: "Net 30", payments: PAID_AT_SALE });
    const a = renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText("Terms & Conditions:")).toBeNull();
    expect(screen.queryByText("Net 30")).toBeNull();
    a.unmount();
    mockInvoice = invoice(COUNTER, { ...TERMS, terms: "All sales final.", payments: PAID_AT_SALE });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByText("All sales final.")).toBeInTheDocument();
  });

  it("an on-account counter invoice keeps the Terms & Conditions row", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(COUNTER, { ...TERMS, status: "SENT", terms: "Net 30", payments: [] });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByText("Terms & Conditions:")).toBeInTheDocument();
  });

  it("a counter sale paid days later still shows its terms and due date", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(COUNTER, {
      ...TERMS,
      payments: [
        { id: "p1", method: "CHECK", amount: "35.00", createdAt: "2026-09-20T10:00:00.000Z" },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("Due Date:")).toBeInTheDocument();
  });
  it("an ordinary order's paid invoice keeps its terms and due date", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice(HANDED, { ...TERMS, payments: PAID_AT_SALE });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("Due Date:")).toBeInTheDocument();
  });
});
