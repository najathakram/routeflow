import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * SA-1066 M5: a DRAFT is not owed yet, so its Balance due is neutral navy (hero, totals summary and the balance card),
 * including a zero balance. Label and amount are unchanged. Every other status keeps its colour.
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

const invoice = (status: string, total: string, paid: string, balance: string) => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status,
  total,
  subtotal: total,
  paidAmount: paid,
  balanceDue: balance,
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
});

beforeEach(() => {
  seedSession("OPERATOR");
  mockCapability = undefined;
});
afterEach(() => seedSession(null));

/** Every "Balance due" label's amount element, with its own colour class. */
const balanceAmounts = () =>
  screen
    .getAllByText("Balance due")
    .map((label) => label.nextElementSibling ?? label.parentElement?.querySelector(".money"))
    .filter((el): el is Element => !!el);

describe("invoice page: Balance due colour by status (SA-1066 M5)", () => {
  it("R5: a DRAFT with a balance reads navy in the hero, the summary and the balance card, same amount", () => {
    mockInvoice = invoice("DRAFT", "35.00", "0.00", "35.00");
    renderWithProviders(<InvoiceDetailPage />);
    const amounts = balanceAmounts();
    expect(amounts.length).toBeGreaterThanOrEqual(3);
    for (const el of amounts) {
      expect(el.textContent).toBe("$35.00");
      expect(el.closest("[class*='text-danger']")).toBeNull();
      expect(el.className + (el.parentElement?.className ?? "")).toMatch(/text-navy/);
    }
  });

  it("R5a: a DRAFT at zero reads navy, not success green", () => {
    mockInvoice = invoice("DRAFT", "0.00", "0.00", "0.00");
    renderWithProviders(<InvoiceDetailPage />);
    const amounts = balanceAmounts();
    expect(amounts.length).toBeGreaterThanOrEqual(2);
    for (const el of amounts) {
      expect(el.closest("[class*='text-success']")).toBeNull();
      expect(el.className + (el.parentElement?.className ?? "")).toMatch(/text-navy/);
    }
  });

  it.each([
    ["SENT", "35.00", "0.00", "35.00", "text-danger"],
    ["PARTIAL", "35.00", "10.00", "25.00", "text-danger"],
    ["PAID", "35.00", "35.00", "0.00", "text-success"],
  ])("R5b: %s keeps %s styling", (status, total, paid, balance, cls) => {
    mockInvoice = invoice(status, total, paid, balance);
    renderWithProviders(<InvoiceDetailPage />);
    const amounts = balanceAmounts();
    expect(amounts.length).toBeGreaterThanOrEqual(1);
    for (const el of amounts) expect(el.closest(`[class*='${cls}']`)).not.toBeNull();
  });
});
