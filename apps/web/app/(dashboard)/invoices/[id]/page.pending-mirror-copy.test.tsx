import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 345: a pending-mirror draft names the moment it becomes sendable from the business's fulfilment capability. While that
 * capability is not known (undefined: loading, or a partial answer) the page names NEITHER delivery nor pickup; a store-only
 * business reads "Ready to send after pickup."; a delivery business keeps "after delivery". The API still refuses to send
 * a mirror before hand-over (the owner rule: a draft until handed over, final at hand-over), so no copy says "now".
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

const draftMirror = () => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status: "DRAFT",
  pendingMirror: true,
  total: "35.00",
  paidAmount: "0.00",
  balanceDue: "35.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [],
  payments: [],
  orderId: "o1",
  order: { status: "CONFIRMED", orderNumber: "ORD-9", fulfillPath: "PICKUP" },
});

beforeEach(() => {
  seedSession("OPERATOR");
  mockInvoice = draftMirror();
});
afterEach(() => seedSession(null));

describe("invoice page: the pending-mirror badge follows the capability", () => {
  it("capability not known yet: neither delivery nor pickup is claimed", () => {
    mockCapability = undefined;
    renderWithProviders(<InvoiceDetailPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("ready to send once it is handed over or delivered");
    expect(text).not.toMatch(/after delivery|after pickup/);
  });

  it("store-only: Ready to send after pickup., never delivery", () => {
    mockCapability = { methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" };
    renderWithProviders(<InvoiceDetailPage />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Ready to send after pickup.");
    expect(text).not.toMatch(/deliver/i);
  });

  it("a delivery business keeps 'after delivery'", () => {
    mockCapability = { methods: ["PICKUP", "ROUTE"], staffDefault: "ROUTE", counter: "optional" };
    renderWithProviders(<InvoiceDetailPage />);
    expect(document.body.textContent).toContain("ready to send after delivery");
  });
});
