import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

/**
 * UXG-R10 C5 PR-2: below md the payments list is a card list (payment number, customer, method
 * and status, amount, with View invoice and Void on the card), the table is md and up only, the
 * three summary tiles are one sideways row, search stays outside the Filters panel and the sort
 * control sits beside the Filters button.
 */

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn() },
}));

const mockUsePayments = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoicePayments: (...a: unknown[]) => mockUsePayments(...a),
  useInvoices: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [{ id: "cust-1", businessName: "Acme Foods" }] } }),
}));

function makePayment(overrides: Record<string, unknown>) {
  return {
    method: "CASH",
    status: "PAID",
    createdAt: "2026-10-01T10:00:00.000Z",
    paidAt: "2026-10-01T10:00:00.000Z",
    settledAt: null,
    reference: null,
    invoice: {
      id: "inv-1",
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      customer: { id: "cust-1", businessName: "Acme Foods" },
    },
    ...overrides,
  };
}

const PAYMENTS = [
  makePayment({ id: "pay-a", paymentNumber: "PAY-A", amount: 40 }),
  makePayment({
    id: "pay-b",
    paymentNumber: "PAY-B",
    amount: 75.5,
    method: "CHECK",
    status: "VOID",
    reference: "CHK-9",
    invoice: {
      id: "inv-2",
      invoiceNumber: "INV-2",
      customerId: "cust-2",
      customer: { id: "cust-2", businessName: "Acme Bakery" },
    },
  }),
];

const SUMMARY = { totalReceived: 115.5, count: 2, advanceBalance: 0 };

const cardList = (container: HTMLElement) =>
  within(container.querySelector("ul.md\\:hidden") as HTMLElement).getAllByRole("listitem");

describe("FinancePaymentsPage — phone cards", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUsePayments.mockReset();
    mockUsePayments.mockReturnValue({
      data: {
        data: PAYMENTS,
        meta: { total: 2, page: 1, limit: 25, totalPages: 1 },
        summary: SUMMARY,
      },
      isLoading: false,
    });
  });

  it("renders one card per payment with number, customer, method, status and amount", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const cards = cardList(container);
    expect(cards).toHaveLength(2);
    const link = within(cards[0]).getByRole("link", { name: "PAY-A" });
    expect(link).toHaveAttribute("href", "/finance/payments/pay-a");
    expect(within(cards[0]).getByText("Acme Foods")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Cash")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Paid")).toBeInTheDocument();
    expect(within(cards[0]).getByText("$40.00")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Check")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Void")).toBeInTheDocument();
    expect(within(cards[1]).getByText("$75.50")).toBeInTheDocument();
    expect(within(cards[1]).getByText("CHK-9")).toBeInTheDocument();
    // The table's amount is green, not danger, so the card's is not danger either.
    expect(within(cards[1]).getByText("$75.50").className).not.toContain("text-danger");
  });

  it("puts View invoice and Void on the card, Void last and 16px from its neighbour, no View receipt", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const cards = cardList(container);
    // The card is the link to the receipt, so there is no View receipt action.
    expect(within(cards[0]).queryByText("View receipt")).toBeNull();
    const view = within(cards[0]).getByRole("link", { name: "View invoice INV-1" });
    expect(view).toHaveAttribute("href", "/invoices/inv-1");
    expect(view.className).toContain("min-h-[44px]");
    const voidBtn = within(cards[0]).getByRole("button", { name: "Void payment PAY-A" });
    expect(voidBtn.className).toContain("min-h-[44px]");
    expect(voidBtn.className).toContain("min-w-[44px]");
    expect(voidBtn.className).toContain("ml-2");
    expect(voidBtn.previousElementSibling).toBe(view);
    expect(voidBtn.nextElementSibling).toBeNull();
    // A void payment has no Void action.
    expect(within(cards[1]).queryByRole("button", { name: /^Void payment/ })).toBeNull();
    expect(within(cards[1]).getByRole("link", { name: "View invoice INV-2" })).toBeInTheDocument();
    // The confirm step is the page's own.
    await user.click(voidBtn);
    expect(screen.getByRole("heading", { name: "Void payment?" })).toBeInTheDocument();
  });

  it("shows the table only from md up", () => {
    renderWithProviders(<FinancePaymentsPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
  });

  it("scrolls the three summary tiles sideways in one row below md, a three-column grid from md up", () => {
    renderWithProviders(<FinancePaymentsPage />);
    const row = screen.getByText("Total received").closest("[data-kpi-row]") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("snap-x");
    expect(row.className).toContain("md:grid");
    expect(row.className).toContain("md:grid-cols-3");
    const cells = row.querySelectorAll("[data-kpi-cell]");
    expect(cells).toHaveLength(3);
    expect((cells[0] as HTMLElement).className).toContain("w-[46%]");
    expect((cells[0] as HTMLElement).className).toContain("shrink-0");
  });

  it("keeps search outside the Filters panel and counts only the other filters", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinancePaymentsPage />);
    const search = screen.getByPlaceholderText(/Search payment #/) as HTMLElement;
    const button = screen.getByRole("button", { name: "Filters" });
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel).not.toContainElement(search);
    expect(search.className).toContain("w-full");
    expect(panel).toContainElement(screen.getByLabelText("From"));
    expect(panel).toContainElement(screen.getByLabelText("To"));
    expect(panel).toContainElement(screen.getByLabelText("Method"));
    expect(panel).toContainElement(screen.getByLabelText("Status"));
    expect(panel).toContainElement(screen.getByLabelText("Customer"));
    expect(panel).toContainElement(screen.getByRole("button", { name: "Export CSV" }));
    await user.type(search, "acme");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Method"), "CASH");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
  });

  it("clears every filter with a text Clear button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinancePaymentsPage />);
    await user.selectOptions(screen.getByLabelText("Status"), "VOID");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("has a phone sort control beside the Filters button; the direction button says what a tap does", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FinancePaymentsPage />);
    const select = screen.getByLabelText("Sort payments by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["paidAt", "Date"],
      ["settledAt", "Bank date"],
      ["paymentNumber", "Payment #"],
      ["method", "Method"],
      ["amount", "Amount"],
    ]);
    const filters = screen.getByRole("button", { name: "Filters" });
    const control = select.closest("div.md\\:hidden") as HTMLElement;
    expect(control.parentElement).toBe(filters.parentElement);
    const last = () => mockUsePayments.mock.calls.at(-1)![0];
    expect(last()).toMatchObject({ sortBy: "paidAt", sortDir: "desc" });
    const dir = screen.getByRole("button", { name: "Sort ascending" });
    expect(dir.className).toContain("h-11");
    expect(dir.className).toContain("w-11");
    await user.click(dir);
    expect(last()).toMatchObject({ sortBy: "paidAt", sortDir: "asc" });
    expect(screen.getByRole("button", { name: "Sort descending" })).toBeInTheDocument();
    await user.selectOptions(select, "amount");
    expect(last()).toMatchObject({ sortBy: "amount", sortDir: "desc" });
  });

  it("is one header row below md with the description hidden", () => {
    renderWithProviders(<FinancePaymentsPage />);
    const desc = screen.getByText("All payments recorded against invoices");
    expect(desc.className).toContain("hidden");
    expect(desc.className).toContain("md:block");
    expect(screen.getByRole("button", { name: "Record payment" }).className).toContain(
      "min-h-[44px]",
    );
  });

  it.each([
    ["loading", { data: undefined, isLoading: true }],
    [
      "empty",
      {
        data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } },
        isLoading: false,
      },
    ],
  ])("while %s, no cards or sort render", (_n, state) => {
    mockUsePayments.mockReturnValue(state);
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    expect(container.querySelector("ul.md\\:hidden")).toBeNull();
    expect(screen.queryByLabelText("Sort payments by")).toBeNull();
  });
});
