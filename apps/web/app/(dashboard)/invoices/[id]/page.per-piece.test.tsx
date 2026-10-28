import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/** SA-1029 W-R1: the staff invoice prints a per-piece price beside a pack line (display only). */
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

const packLine = {
  id: "item-1",
  productId: "p1",
  description: "Acme Pack",
  qty: 48,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 48,
  discount: 0,
  subtotal: 96,
  total: 96,
  components: null,
  displayUnit: { kind: "legacy", label: null },
};
const looseLine = {
  ...packLine,
  id: "item-2",
  description: "Acme Loose",
  qty: 3,
  boxes: 0,
  pieces: 3,
  unitsPerBox: 1,
  unitPrice: 5,
  subtotal: 15,
  total: 15,
};

const invoiceWith = (item: Record<string, unknown>) => ({
  id: "inv-1",
  invoiceNumber: "INV-0015",
  status: "SENT",
  subtotal: "60.02",
  total: "60.02",
  paidAmount: "0.00",
  balanceDue: "60.02",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [item],
  payments: [],
});

beforeEach(() => seedSession("OPERATOR"));
afterEach(() => seedSession(null));

describe("SA-1029 staff invoice: per-piece price column", () => {
  it("W-R1: a pack line shows a Per piece header and $2.00/pc", () => {
    mockInvoice = invoiceWith({ ...packLine, perBaseUnit: { price: 2, unit: "pc" } });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getAllByText("Per piece").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2.00/pc").length).toBeGreaterThan(0);
  });

  it("G-1: a loose-only invoice has no Per piece column", () => {
    mockInvoice = invoiceWith({ ...looseLine, perBaseUnit: null });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText("Per piece")).toBeNull();
  });

  it("G-3: the pieces layout stays unchanged (no per-piece cell)", () => {
    mockInvoice = invoiceWith({
      ...packLine,
      displayUnit: { kind: "pieces", label: "Piece" },
      perBaseUnit: { price: 2, unit: "pc" },
    });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.queryByText("$2.00/pc")).toBeNull();
  });

  it("G-7: a Case line prints the per-piece price with the Case Qty text", () => {
    mockInvoice = invoiceWith({
      ...packLine,
      qty: 72,
      boxes: 3,
      unitsPerBox: 24,
      unitPrice: 40,
      subtotal: 120,
      total: 120,
      perBaseUnit: { price: 1.6667, unit: "pc" },
      unitLabel: "Case",
    });
    renderWithProviders(<InvoiceDetailPage />);
    expect(screen.getAllByText("$1.6667/pc").length).toBeGreaterThan(0);
  });
});
