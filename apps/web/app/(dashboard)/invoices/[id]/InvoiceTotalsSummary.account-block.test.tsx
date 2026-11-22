import { renderWithProviders as render, screen } from "@/test-utils/render";
import { InvoiceTotalsSummary, type InvoiceTotalsSummaryProps } from "./InvoiceTotalsSummary";

// SA-1197 (T22, C5): the staff invoice view prints the server's account rows as given, under Balance due, in a neutral
// tone. It never adds: given rows whose open balance is deliberately NOT others + this, it prints the server's figure.
const BASE: InvoiceTotalsSummaryProps = {
  subtotal: 50,
  discount: 0,
  taxAmount: 0,
  shippingFee: 0,
  amountPaid: 0,
  creditApplied: 0,
  advanceApplied: 0,
  balanceDue: 50,
};
const ROWS = [
  {
    kind: "heading" as const,
    label: "Customer account balance as of Nov 21, 2026, 4:46 PM CST",
    amount: null,
  },
  { kind: "others" as const, label: "Other unpaid invoices", amount: 30 },
  { kind: "thisInvoice" as const, label: "This invoice", amount: 50 },
  // deliberately not 30 + 50: the screen must print the server's figure, never its own sum
  { kind: "openBalance" as const, label: "Open balance", amount: 99 },
];

describe("InvoiceTotalsSummary: the account block (SA-1197)", () => {
  it("prints nothing without rows (today's footer)", () => {
    render(<InvoiceTotalsSummary {...BASE} />);
    expect(screen.queryByTestId("invoice-account-block")).toBeNull();
  });

  it("T22: prints the server's rows and figure as given, never a sum of its own", () => {
    render(<InvoiceTotalsSummary {...BASE} accountBlock={ROWS} />);
    const block = screen.getByTestId("invoice-account-block");
    expect(block).toHaveTextContent("Customer account balance as of Nov 21, 2026, 4:46 PM CST");
    expect(block).toHaveTextContent("Other unpaid invoices$30.00");
    expect(block).toHaveTextContent("This invoice$50.00");
    expect(block).toHaveTextContent("Open balance$99.00");
    expect(block).not.toHaveTextContent("$80.00");
  });

  it("T22: the block is neutral, never the danger or success tone", () => {
    render(<InvoiceTotalsSummary {...BASE} accountBlock={ROWS} />);
    const block = screen.getByTestId("invoice-account-block");
    expect(block.outerHTML).not.toMatch(/text-danger|text-success/);
  });

  it("sits below Balance due", () => {
    render(<InvoiceTotalsSummary {...BASE} accountBlock={ROWS} />);
    const balance = screen.getByText("Balance due");
    const block = screen.getByTestId("invoice-account-block");
    expect(balance.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
