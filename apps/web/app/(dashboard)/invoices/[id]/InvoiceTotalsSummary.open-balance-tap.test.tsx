import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { InvoiceTotalsSummary, type InvoiceTotalsSummaryProps } from "./InvoiceTotalsSummary";

/**
 * SA-1197 A3 (read B M3, SA-1078 U21): on the staff invoice page the account block's Open balance figure is the
 * statement's figure, so it taps to the one statement sheet, like every other staff place that prints it. The heading,
 * "Other unpaid invoices" and "This invoice" are parts, so they stay plain. On a DRAFT the figure stays plain (C15: a
 * draft's block is a forecast the statement does not hold yet), and with no customer there is nothing to open.
 */
let mockMay = true;
jest.mock("@/lib/api/account-statement", () => ({
  ...jest.requireActual("@/lib/api/account-statement"),
  useMayOpenStatement: () => mockMay,
}));
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

const BASE: InvoiceTotalsSummaryProps = {
  subtotal: 50,
  discount: 0,
  taxAmount: 0,
  shippingFee: 0,
  amountPaid: 0,
  creditApplied: 0,
  advanceApplied: 0,
  balanceDue: 50,
  accountBlock: [
    { kind: "heading", label: "Your account on Nov 20, 2026", amount: null },
    { kind: "others", label: "Other unpaid invoices", amount: 30 },
    { kind: "thisInvoice", label: "This invoice", amount: 50 },
    { kind: "openBalance", label: "Open balance", amount: 80 },
  ],
};

beforeEach(() => {
  mockMay = true;
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/customers/cust-1/account-statement")
      return Promise.resolve({
        data: {
          asOf: "2026-11-20T15:00:00.000Z",
          customer: { id: "cust-1", businessName: "Acme Foods" },
          openBalance: 80,
          overdue: 0,
          creditAvailable: 0,
          afterCredit: 0,
          waitingToClear: 0,
          openInvoices: [],
          recentPayments: [],
          recentPaymentsTruncated: false,
          credits: [],
        },
      });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
});

describe("InvoiceTotalsSummary: the Open balance figure opens the statement (SA-1197 A3)", () => {
  it("(ii) exactly one button, on the Open balance amount; the parts are plain", () => {
    renderWithProviders(<InvoiceTotalsSummary {...BASE} customerId="cust-1" />);
    const block = screen.getByTestId("invoice-account-block");
    const buttons = within(block).getAllByTestId("open-balance-button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("$80.00");
    for (const part of ["$30.00", "$50.00"]) {
      expect(within(block).getByText(part).closest("button")).toBeNull();
    }
    expect(within(block).getByText("Your account on Nov 20, 2026").closest("button")).toBeNull();
  });

  it("the hidden-Balance-Due form's one row taps too", () => {
    renderWithProviders(
      <InvoiceTotalsSummary
        {...BASE}
        customerId="cust-1"
        accountBlock={[
          { kind: "openBalanceOn", label: "Open balance on Nov 20, 2026", amount: 80 },
        ]}
      />,
    );
    expect(screen.getByTestId("open-balance-button")).toHaveTextContent("$80.00");
  });

  it("(iii) no customerId -> the figure is plain", () => {
    renderWithProviders(<InvoiceTotalsSummary {...BASE} />);
    expect(screen.queryByTestId("open-balance-button")).toBeNull();
    expect(
      within(screen.getByTestId("invoice-account-block")).getByText("$80.00"),
    ).toBeInTheDocument();
  });

  it("(iv) a DRAFT -> the figure is plain (C15)", () => {
    renderWithProviders(<InvoiceTotalsSummary {...BASE} customerId="cust-1" isDraft />);
    expect(screen.queryByTestId("open-balance-button")).toBeNull();
    expect(
      within(screen.getByTestId("invoice-account-block")).getByText("$80.00"),
    ).toBeInTheDocument();
  });

  it("(v) a tap opens the statement sheet for this invoice's customer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceTotalsSummary {...BASE} customerId="cust-1" />);
    await user.click(screen.getByTestId("open-balance-button"));
    expect(await screen.findByRole("dialog", { name: "Statement" })).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/customers/cust-1/account-statement");
  });
});
