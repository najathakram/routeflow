import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 616: a Stripe refund/dispute on a card payment appends a "[REVIEW] ..." line to the invoice's staff-only
 * internal notes. Nothing rendered internalNotes, so the flag was invisible. Staff now see a "Needs review" banner;
 * a CUSTOMER-role viewer of the same page never does (the API strips internalNotes for them too).
 */
let mockInvoice: Record<string, unknown>;
let mockCapability: unknown;

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
  useCounterSaleGate: () => ({ capability: mockCapability, loading: false }),
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

const paidInvoice = (internalNotes: string | undefined) => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status: "PAID",
  total: "35.00",
  paidAmount: "35.00",
  balanceDue: "0.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
  internalNotes,
});
const REVIEW =
  "[REVIEW] Stripe reported a refund on a card payment for this invoice (evt_1). It is still recorded as paid; confirm the amount in Stripe and adjust if needed.";

afterEach(() => seedSession(null));

describe("invoice page: the Stripe review flag (row 616)", () => {
  it("staff see a Needs review banner carrying the flagged line", () => {
    seedSession("OPERATOR");
    mockInvoice = paidInvoice(`older note\n${REVIEW}`);
    renderWithProviders(<InvoiceDetailPage />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Needs review:");
    expect(banner.textContent).toContain("Stripe reported a refund on a card payment");
    expect(banner.textContent).not.toContain("[REVIEW]");
    expect(banner.textContent).not.toContain("older note");
  });

  it("no banner when the notes carry no review line", () => {
    seedSession("OPERATOR");
    mockInvoice = paidInvoice("just a note");
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText(/Needs review/)).toBeNull();
  });

  it("a CUSTOMER-role viewer never sees it, even if the field were present", () => {
    seedSession("CUSTOMER");
    mockInvoice = paidInvoice(REVIEW);
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText(/Needs review/)).toBeNull();
    expect(document.body.textContent).not.toContain("Stripe reported");
  });
});
