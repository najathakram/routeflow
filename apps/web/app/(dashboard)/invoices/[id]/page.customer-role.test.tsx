import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * REG-B1: a CUSTOMER session sees the invoice read-only. The staff controls (toolbar, the "What's next" banner's
 * Record payment, the Payment History Record payment) never render for it; it gets a plain due line instead.
 * Harness as page.to-collect.test.tsx. The API refuses every write anyway; this pins the web display.
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
  status: "OVERDUE",
  total: "35.00",
  paidAmount: "0.00",
  balanceDue: "35.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-10-01",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
  ...over,
});

/** All 10 staff-control concepts with their real accessible names in page.tsx (button or link, exact name). */
const INVENTORY: { label: string; name: RegExp }[] = [
  { label: "Record payment", name: /^Record payment$/ },
  { label: "Send reminder", name: /^Send reminder$/ },
  { label: "Adjust prices", name: /^Adjust prices$/ },
  { label: "Revert to draft", name: /^Revert to draft$/ },
  { label: "Edit", name: /^Edit$/ },
  { label: "More actions", name: /^More actions$/ }, // title attribute on the icon-only button
  { label: "Print", name: /^Print$/ },
  { label: "PDF", name: /^PDF$/ },
  { label: "Send", name: /^Send$/ },
  { label: "Email again", name: /^Email again$/ },
  // Shipment card (a standalone invoice always shows it); "Edit shipment" appears once a carrier is recorded.
  { label: "Add tracking", name: /^Add tracking$/ },
  { label: "Edit shipment", name: /^Edit shipment$/ },
];

const count = (name: RegExp) =>
  screen.queryAllByRole("button", { name }).length + screen.queryAllByRole("link", { name }).length;

afterEach(() => seedSession(null));

describe("REG-B1 invoice page by role", () => {
  it("REG-B1 a CUSTOMER sees no staff control and a plain due line", () => {
    seedSession("CUSTOMER");
    mockInvoice = invoice();
    renderWithProviders(<InvoiceDetailPage />);

    for (const { label, name } of INVENTORY) {
      const c = count(name);
      expect({ label, count: c }).toEqual({ label, count: 0 });
    }
    expect(screen.queryByText(/Contact your customer/)).toBeNull();
    expect(screen.getByTestId("customer-due-line")).toHaveTextContent(/Overdue · balance/);
  });

  it("REG-B1 a CUSTOMER sees no Edit shipment once a carrier is recorded; an OPERATOR twin does", () => {
    seedSession("CUSTOMER");
    mockInvoice = invoice({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" });
    const first = renderWithProviders(<InvoiceDetailPage />);
    for (const label of ["Edit shipment", "Add tracking"]) {
      const c = count(new RegExp(`^${label}$`));
      expect({ label, count: c }).toEqual({ label, count: 0 });
    }
    first.unmount();

    seedSession("OPERATOR");
    renderWithProviders(<InvoiceDetailPage />);
    const c = count(/^Edit shipment$/);
    expect({ label: "Edit shipment", count: c >= 1 }).toEqual({
      label: "Edit shipment",
      count: true,
    });
  });

  // A raw platform session passes the API's OPERATOR gate, so it keeps the staff controls too.
  it("REG-B1 a SUPER_ADMIN keeps the staff controls and gets no customer due line", () => {
    seedSession("SUPER_ADMIN");
    mockInvoice = invoice();
    renderWithProviders(<InvoiceDetailPage />);
    expect({ label: "Record payment", count: count(/^Record payment$/) >= 1 }).toEqual({
      label: "Record payment",
      count: true,
    });
    expect({ label: "Print", count: count(/^Print$/) }).toEqual({ label: "Print", count: 1 });
    expect(screen.queryByTestId("customer-due-line")).toBeNull();
  });

  it("REG-B1 an OPERATOR twin still gets the controls (the scan finds the labels)", () => {
    seedSession("OPERATOR");
    mockInvoice = invoice();
    renderWithProviders(<InvoiceDetailPage />);

    const counts = Object.fromEntries(INVENTORY.map(({ label, name }) => [label, count(name)]));
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect({ sum, counts }.sum).toBeGreaterThanOrEqual(1);
    expect({ label: "Record payment", count: counts["Record payment"] >= 1 }).toEqual({
      label: "Record payment",
      count: true,
    });
    expect({ label: "More actions", count: counts["More actions"] >= 1 }).toEqual({
      label: "More actions",
      count: true,
    });
    expect({ label: "Print", count: counts["Print"] }).toEqual({ label: "Print", count: 1 });
    expect(screen.queryByTestId("customer-due-line")).toBeNull();
  });
});
