import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 345 + SA-1066 M3/M4: a pending-mirror draft names the moment it becomes sendable, from the ORDER's own path first
 * (a PICKUP order is picked up at a mixed business too) and the business's fulfilment capability otherwise. While neither is
 * known the page names NEITHER delivery nor pickup. There is no pill: the one reason sits beside the locked Send ("Sends
 * after pickup" / "Sends after delivery"), and the note under the header keeps the long form. The API still refuses to send
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
  sendLocked: { reason: "SENDS_AFTER_DELIVERY" },
  order: { status: "CONFIRMED", orderNumber: "ORD-9", fulfillPath: "PICKUP" },
});

beforeEach(() => {
  seedSession("OPERATOR");
  mockInvoice = draftMirror();
});
afterEach(() => seedSession(null));

const STORE_ONLY = { methods: ["PICKUP"], staffDefault: "PICKUP", counter: "always" };
const MIXED = { methods: ["PICKUP", "ROUTE"], staffDefault: "ROUTE", counter: "optional" };
const show = (fulfillPath: string, capability: unknown) => {
  mockCapability = capability;
  mockInvoice = { ...draftMirror(), order: { ...draftMirror().order, fulfillPath } };
  renderWithProviders(<InvoiceDetailPage />);
  return document.body.textContent ?? "";
};

describe("invoice page: the pending-mirror wording follows the order, then the capability", () => {
  it("R3: a PICKUP order at a mixed business says pickup and handed over, never delivery", () => {
    const text = show("PICKUP", MIXED);
    expect(text).toContain("you'll review and send this invoice after pickup.");
    expect(text).toContain("until it's handed over.");
    expect(screen.getByText("Sends after pickup")).toBeInTheDocument();
    expect(text).not.toMatch(/deliver/i);
  });

  it("R3a: a ROUTE order at the same business says delivery", () => {
    const text = show("ROUTE", MIXED);
    expect(text).toContain("you'll review and send this invoice after delivery.");
    expect(text).toContain("until it's delivered.");
    expect(screen.getByText("Sends after delivery")).toBeInTheDocument();
  });

  it("R3b: capability not known: a PICKUP order still says pickup", () => {
    const text = show("PICKUP", undefined);
    expect(text).toContain("you'll review and send this invoice after pickup.");
    expect(screen.getByText("Sends after pickup")).toBeInTheDocument();
  });

  it("R3b: capability not known: any other order is neutral, naming neither moment", () => {
    const text = show("ROUTE", undefined);
    expect(text).toContain("once it is handed over or delivered.");
    expect(text).not.toMatch(/after delivery|after pickup/);
    expect(screen.getByText("Sends once handed over or delivered")).toBeInTheDocument();
  });

  it("a store-only business with a ROUTE-less order still reads pickup", () => {
    const text = show("SHIP", STORE_ONLY);
    expect(text).toContain("after pickup.");
  });

  it("R4: no pill repeats the reason", () => {
    const text = show("PICKUP", MIXED);
    expect(text).not.toContain("Mirrors the order");
    expect(text).not.toContain("Ready to send after pickup.");
    expect(text).not.toMatch(/ready to send after delivery/i);
  });

  it("R4a: Send is disabled and the reason beside it is what describes it", () => {
    show("ROUTE", MIXED);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription("Sends after delivery");
  });
});
