import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * SA-1026 A: the invoice header's To collect chip, from the server's derived field (staff reads only). Harness as the row 342
 * hand-over stamp test.
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

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  invoiceNumber: "INV-0014",
  status: "SENT",
  total: "35.00",
  paidAmount: "0.00",
  balanceDue: "35.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
  ...over,
});

afterEach(() => seedSession(null));

describe("invoice header To collect chip (SA-1026)", () => {
  it("staff see the chip on an invoice the server marked", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice({ toCollect: "TO_COLLECT" });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByTestId("to-collect-chip")).toHaveTextContent("To collect");
  });

  it("an unmarked invoice shows no chip", () => {
    seedSession("TENANT_ADMIN");
    mockInvoice = invoice({ toCollect: "NONE" });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("to-collect-chip")).toBeNull();
  });

  it("a customer session never shows it, whatever the payload carries", () => {
    seedSession("CUSTOMER");
    mockInvoice = invoice({ toCollect: "TO_COLLECT" });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByTestId("to-collect-chip")).toBeNull();
  });
});
