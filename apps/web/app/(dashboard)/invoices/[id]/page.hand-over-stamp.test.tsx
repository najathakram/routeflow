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

const invoice = (order?: Record<string, unknown>) => ({
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
  it("an unstamped register (null) reads as main", () => {
    seedSession("TENANT_ADMIN");
    mockInvoice = invoice({ ...HANDED, registerKey: null, handedOverBy: null, soldBy: null });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByTestId("hand-over-stamp")).toHaveTextContent("Handed over · main");
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
