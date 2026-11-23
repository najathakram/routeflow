import { invoiceItem } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { INVOICE_ACCOUNT_LABELS, type InvoiceAccountRow } from "@routeflow/types";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * SA-1228 D5: the buyer's invoice page prints the server's account rows as given, under the summary tiles.
 * No staff statement tap (no button or link inside the block); the Balance due tile is unchanged.
 */
const ROWS: InvoiceAccountRow[] = [
  {
    kind: "heading",
    label: INVOICE_ACCOUNT_LABELS.heading.replace("{date}", "Nov 20"),
    amount: null,
  },
  { kind: "others", label: INVOICE_ACCOUNT_LABELS.others, amount: 30 },
  { kind: "thisInvoice", label: INVOICE_ACCOUNT_LABELS.thisInvoice, amount: 150 },
  { kind: "openBalance", label: INVOICE_ACCOUNT_LABELS.openBalance, amount: 180 },
];

function makeInvoice(overrides: Partial<BuyerInvoiceDetail> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "SENT",
    subtotal: 150,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 150,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    items: [
      invoiceItem({
        id: "item-1",
        description: "Widget",
        productId: "p1",
        qty: 1,
        unitPrice: 150,
        discount: 0,
        subtotal: 150,
        priceType: "STANDARD",
      }),
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
    ...overrides,
  };
}

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: makeInvoice({ accountBlock: ROWS }),
  isLoading: false,
  isError: false,
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "seller-1", slug: "acme" }, isLoading: false }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: (...args: unknown[]) => mockUseBuyerInvoice(...args),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

const show = (data: BuyerInvoiceDetail) => {
  mockUseBuyerInvoice.mockReturnValue({ data, isLoading: false, isError: false });
  renderWithProviders(<Page />);
};

describe("buyer invoice page: the account rows (SA-1228 D5)", () => {
  it("R6: prints each server label and figure as given, after the tiles, with no tap", () => {
    show(makeInvoice({ accountBlock: ROWS }));
    const block = screen.getByTestId("invoice-account-block");
    const tiles = screen.getByTestId("invoice-summary-tiles");
    expect(tiles.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const row of ROWS) expect(within(block).getByText(row.label)).toBeInTheDocument();
    expect(block).toHaveTextContent("$30.00");
    expect(block).toHaveTextContent("$150.00");
    expect(block).toHaveTextContent("$180.00");
    expect(within(block).queryByRole("button")).toBeNull();
    expect(within(block).queryByRole("link")).toBeNull();
    expect(screen.getByTestId("invoice-tile-balance")).toHaveTextContent("$150.00");
  });

  it("R6: an empty list renders no block", () => {
    show(makeInvoice({ accountBlock: [] }));
    expect(screen.queryByTestId("invoice-account-block")).toBeNull();
  });

  it("R6: an absent key renders no block", () => {
    show(makeInvoice());
    expect(screen.queryByTestId("invoice-account-block")).toBeNull();
  });
});
