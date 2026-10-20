import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/** SA-827: the staff invoice keeps the box line's own row (notes, free note, MSRP, amount) in every layout. */
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

const comps = [
  {
    componentProductId: "a1",
    name: "Acme Alpha",
    qty: 10,
    unitSku: "AL-1",
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: 0.63,
    position: 0,
  },
  {
    componentProductId: "a2",
    name: "Acme Beta",
    qty: 20,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: 0.63,
    position: 1,
  },
];
const boxLine = {
  id: "item-1",
  description: "Acme Mixed Box",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitPrice: 30.01,
  discount: 0,
  subtotal: 60.02,
  total: 60.02,
  notes: "Leave at the back door",
  msrp: 4.99,
  promoFreeUnits: 2,
  categoryTaxAmount: 3.5,
  trackedCategory: { id: "tc1", name: "Tobacco", invoiceTreatment: "SEPARATE_LINE" },
  components: comps,
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

describe("staff invoice page: display units", () => {
  it("components: 2 component rows, then the group row with its notes and amount, then the tax row; no (included)", () => {
    mockInvoice = invoiceWith({ ...boxLine, displayUnit: { kind: "pieces", label: "Piece" } });
    renderWithProviders(<InvoiceDetailPage />);
    const a1 = screen.getByTestId("display-row-item-1-a1");
    const a2 = screen.getByTestId("display-row-item-1-a2");
    const group = screen.getByTestId("display-group-row-item-1");
    const tax = screen.getByTestId("display-category-tax-item-1");
    expect(a1).toHaveTextContent("10 Pieces");
    expect(a1).toHaveTextContent("SKU AL-1");
    expect(a2).toHaveTextContent("$40.01");
    expect(group).toHaveTextContent("Acme Mixed Box");
    expect(group).toHaveTextContent("Leave at the back door");
    expect(group).toHaveTextContent("2 free");
    expect(group).toHaveTextContent("MSRP $4.99/pc");
    expect(group).toHaveTextContent("$60.02");
    expect(screen.queryByTestId("line-components")).toBeNull();
    expect(screen.queryByText(/\(included\)/)).toBeNull();
    expect(tax).toHaveTextContent("Tobacco tax");
    const after = (x: HTMLElement, y: HTMLElement) =>
      Boolean(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(a1, a2) && after(a2, group) && after(group, tax)).toBe(true);
  });

  it("pieces: only the qty and unit-price cells change; notes, free note, MSRP and amount stay", () => {
    mockInvoice = invoiceWith({
      ...boxLine,
      components: null,
      displayUnit: { kind: "pieces", label: "Piece" },
    });
    renderWithProviders(<InvoiceDetailPage />);
    const row = screen.getByTestId("display-pieces-item-1");
    expect(row).toHaveTextContent("30 Pieces");
    expect(row).toHaveTextContent("$2.0007");
    expect(row).toHaveTextContent("Leave at the back door");
    expect(row).toHaveTextContent("2 free");
    expect(row).toHaveTextContent("MSRP $4.99/pc");
    expect(row).toHaveTextContent("$60.02");
  });
});
