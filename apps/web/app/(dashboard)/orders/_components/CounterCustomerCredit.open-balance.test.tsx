import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { CounterCustomerCredit } from "./CounterCustomerCredit";

/**
 * SA-1078 U3: on the counter the Open balance figure opens the statement sheet. The sheet is its own component with its own
 * state, so closing it leaves the sale's cart, customer and tender where they were: here a parent holds that state and
 * the test proves it survives open and close.
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

beforeEach(() => {
  mockMay = true;
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/customers/c1") return Promise.resolve({ data: { id: "c1", creditLimit: 5000 } });
    if (url === "/customers/c1/statement")
      return Promise.resolve({ data: { outstandingAmount: 320, overdueAmount: 0 } });
    if (url === "/settings/invoice") return Promise.resolve({ data: { defaultTerms: "Net 30" } });
    if (url === "/customers/c1/account-statement")
      return Promise.resolve({
        data: {
          asOf: "2026-10-31T15:00:00.000Z",
          customer: { id: "c1", businessName: "Acme Foods" },
          openBalance: 320,
          overdue: 0,
          creditAvailable: 0,
          afterCredit: 0,
          waitingToClear: 0,
          openInvoices: [
            {
              id: "inv-1",
              invoiceNumber: "INV-1001",
              issueDate: "2026-10-01T00:00:00.000Z",
              dueDate: "2026-11-15T00:00:00.000Z",
              total: 320,
              paid: 0,
              credit: 0,
              unpaid: 320,
              daysLate: 0,
            },
          ],
          recentPayments: [],
          recentPaymentsTruncated: false,
          credits: [],
        },
      });
    return Promise.reject(new Error(`unmocked ${url}`));
  });
});

function Till() {
  const [cart, setCart] = React.useState("2 x Widget");
  const [tender, setTender] = React.useState("Cash");
  return (
    <div>
      <input aria-label="cart" value={cart} onChange={(e) => setCart(e.target.value)} />
      <input aria-label="tender" value={tender} onChange={(e) => setTender(e.target.value)} />
      <CounterCustomerCredit customerId="c1" />
    </div>
  );
}

describe("CounterCustomerCredit: Open balance opens the statement sheet (U3)", () => {
  it("opens the sheet, shows the invoice as plain text, and closing leaves the sale untouched", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Till />);
    await user.clear(screen.getByLabelText("cart"));
    await user.type(screen.getByLabelText("cart"), "5 x Gadget");
    await user.clear(screen.getByLabelText("tender"));
    await user.type(screen.getByLabelText("tender"), "Check");

    const panel = screen.getByTestId("counter-customer-credit");
    const figure = await within(panel).findByTestId("open-balance-button");
    expect(figure).toHaveTextContent("$320.00");
    await user.click(figure);

    expect(await screen.findByRole("dialog", { name: "Statement" })).toBeInTheDocument();
    // U20: nothing in the sheet can navigate away from a sale in progress
    expect(await screen.findAllByText("INV-1001")).not.toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("cart")).toHaveValue("5 x Gadget");
    expect(screen.getByLabelText("tender")).toHaveValue("Check");
  });

  it("U7: without permission the figure is plain text", async () => {
    mockMay = false;
    renderWithProviders(<Till />);
    const panel = screen.getByTestId("counter-customer-credit");
    expect(await within(panel).findByText("$320.00")).toBeInTheDocument();
    expect(within(panel).queryByTestId("open-balance-button")).toBeNull();
  });
});
