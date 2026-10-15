import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import InvoiceDetailPage from "./page";

/**
 * R4 (SA-770): a past-due PARTIAL invoice that still owes $5 had no "Send Reminder" button (the gate
 * listed SENT / VIEWED / OVERDUE only). The button now follows `canSendReminder`: an issued, unpaid
 * invoice (SENT / VIEWED / PARTIAL / OVERDUE) with a balance due.
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

function invoice(status: string, balanceDue: string, total = "35.00") {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0014",
    status,
    total,
    paidAmount: String(Number(total) - Number(balanceDue)),
    balanceDue,
    issueDate: "2026-09-01T00:00:00.000Z",
    dueDate: "2026-09-15T00:00:00.000Z",
    customer: { id: "c1", businessName: "Acme Foods", email: "ap@acme.test" },
    items: [],
    payments: [],
  };
}

describe("InvoiceDetailPage — Send Reminder gate (R4)", () => {
  it("shows Send Reminder on a past-due PARTIAL invoice that owes a balance", () => {
    mockInvoice = invoice("PARTIAL", "5.00");
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByRole("button", { name: /send reminder/i })).toBeInTheDocument();
  });

  it("still shows it on an OVERDUE invoice", () => {
    mockInvoice = invoice("OVERDUE", "30.00", "30.00");
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getByRole("button", { name: /send reminder/i })).toBeInTheDocument();
  });

  it("hides it on a PARTIAL invoice with nothing left to collect", () => {
    mockInvoice = invoice("PARTIAL", "0.00");
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByRole("button", { name: /send reminder/i })).not.toBeInTheDocument();
  });

  it("hides it on a PAID invoice", () => {
    mockInvoice = invoice("PAID", "0.00");
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByRole("button", { name: /send reminder/i })).not.toBeInTheDocument();
  });
});
