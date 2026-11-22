import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import FinancePaymentsPage from "./page";

/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): the Payments list shows ONE row per check. A $4,000 check over invoice A ($3,000) and
 * invoice B ($1,000) is stored as two rows; the server tags each with `receiptGroup` ({ key, total, number, invoices }),
 * so the screen prints the server's total and never sums the rows. Rows with no group read as before.
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

const RECEIPT_GROUP = {
  key: "grp-1",
  number: "PAY-0001",
  total: 4000,
  invoices: [
    { id: "inv-a", invoiceNumber: "INV-ACME-A" },
    { id: "inv-b", invoiceNumber: "INV-ACME-B" },
  ],
};

function makePayment(overrides: Record<string, unknown>) {
  return {
    method: "CHECK",
    status: "PAID",
    reference: "1001",
    createdAt: "2026-11-21T10:00:00.000Z",
    paidAt: "2026-11-21T10:00:00.000Z",
    settledAt: null,
    invoice: {
      id: "inv-a",
      invoiceNumber: "INV-ACME-A",
      customerId: "cust-1",
      customer: { id: "cust-1", businessName: "Acme Foods" },
    },
    ...overrides,
  };
}

const CHECK_A = makePayment({
  id: "pay-a",
  paymentNumber: "PAY-0001",
  amount: 3000,
  paymentGroupId: "grp-1",
  receiptGroup: RECEIPT_GROUP,
});
const CHECK_B = makePayment({
  id: "pay-b",
  paymentNumber: "PAY-0002",
  amount: 1000,
  paymentGroupId: "grp-1",
  receiptGroup: RECEIPT_GROUP,
  invoice: {
    id: "inv-b",
    invoiceNumber: "INV-ACME-B",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods" },
  },
});
const CASH_C = makePayment({
  id: "pay-c",
  paymentNumber: "PAY-0003",
  amount: 75.5,
  method: "CASH",
  reference: null,
  paymentGroupId: null,
  receiptGroup: null,
  invoice: {
    id: "inv-c",
    invoiceNumber: "INV-ACME-C",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods" },
  },
});

const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr")) as HTMLElement[];

function show(rows: unknown[]) {
  mockUsePayments.mockReturnValue({
    data: {
      data: rows,
      meta: { total: rows.length, page: 1, limit: 25, totalPages: 1 },
      summary: { totalReceived: 4075.5, count: rows.length, advanceBalance: 0 },
    },
    isLoading: false,
  });
}

describe("Payments list: one row per check", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUsePayments.mockReset();
    show([CHECK_A, CHECK_B, CASH_C]);
  });

  it("shows the $4,000 check as ONE row with the server's total and both invoices", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2); // the check, and the unrelated cash payment
    const check = rows[0];
    expect(within(check).getByText("$4,000.00")).toBeInTheDocument();
    expect(within(check).queryByText("$3,000.00")).not.toBeInTheDocument();
    expect(within(check).queryByText("$1,000.00")).not.toBeInTheDocument();
    expect(within(check).getByRole("link", { name: "INV-ACME-A" })).toHaveAttribute(
      "href",
      "/invoices/inv-a",
    );
    expect(within(check).getByRole("link", { name: "INV-ACME-B" })).toHaveAttribute(
      "href",
      "/invoices/inv-b",
    );
    expect(within(check).getByText("PAY-0001")).toBeInTheDocument();
  });

  it("leaves a payment with no group exactly as it was", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const cash = bodyRows(container)[1];
    expect(within(cash).getByText("$75.50")).toBeInTheDocument();
    expect(within(cash).getByText("PAY-0003")).toBeInTheDocument();
    expect(within(cash).getByRole("button", { name: "Void" })).toBeInTheDocument();
  });

  it("opens the receipt from the check's row", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    await user.click(within(bodyRows(container)[0]).getByText("PAY-0001"));
    expect(mockPush).toHaveBeenCalledWith("/finance/payments/pay-a");
  });

  it("does not offer a one-row Void on the $4,000 row (void is per row, on the receipt)", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    expect(within(bodyRows(container)[0]).queryByRole("button", { name: "Void" })).toBeNull();
  });

  it("shows one phone card for the check, with the total", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const cards = within(container.querySelector("ul.md\\:hidden") as HTMLElement).getAllByRole(
      "listitem",
    );
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("$4,000.00")).toBeInTheDocument();
  });

  it("keeps an unconfirmed row of the same group on its own (its money is not in the check's total)", () => {
    const confirmedOnly = {
      ...RECEIPT_GROUP,
      total: 3000,
      invoices: [RECEIPT_GROUP.invoices[0]],
    };
    show([
      { ...CHECK_A, receiptGroup: confirmedOnly },
      { ...CHECK_B, status: "DRAFT", receiptGroup: null }, // the server never tags an unconfirmed row
    ]);
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const rows = bodyRows(container);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("$3,000.00")).toBeInTheDocument();
    expect(within(rows[1]).getByText("$1,000.00")).toBeInTheDocument();
  });

  it("aligns every item of the row menu to the left (the link inherited the cell's right alignment)", () => {
    const { container } = renderWithProviders(<FinancePaymentsPage />);
    const menu = within(bodyRows(container)[1]).getByText("View invoice")
      .parentElement as HTMLElement;
    expect(menu.className).toContain("text-left");
  });
});
