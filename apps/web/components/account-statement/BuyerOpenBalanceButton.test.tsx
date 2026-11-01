import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { useBuyerStatement } from "@/lib/api/buyer";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { BuyerOpenBalanceButton } from "./BuyerOpenBalanceButton";

/**
 * SA-1078 W-1096 PR-6: the buyer's twin of the staff figure.
 *   BP1  tapping the Outstanding figure opens the same view, labelled Open balance, equal to the cent
 *   BP2  the buyer's actions are Print only: no Email, no staff tags, no link out of the portal
 * Real hooks and a real QueryClient; only the two HTTP clients are mocked. The staff client must never be touched.
 */
const mockBuyerGet = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { get: (...a: unknown[]) => mockBuyerGet(...a) },
}));
const mockStaffGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockStaffGet(...a) },
}));
const mockFetchBlob = jest.fn();
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: (...a: unknown[]) => mockFetchBlob(...a),
}));
const mockPrint = jest.fn();
jest.mock("@/lib/print-pdf-blob", () => ({ printPdfBlob: (...a: unknown[]) => mockPrint(...a) }));
jest.mock("@/lib/in-shell", () => ({ isInShell: () => false }));

const SIGNED = "https://files.example.test/statement-pdfs/c1/current.pdf?sig=abc";
const inv = (n: number) => ({
  id: `i${n}`,
  invoiceNumber: `INV-00${n}`,
  dueDate: "2026-10-01",
  daysLate: n === 1 ? 30 : 0,
  total: 600,
  paid: 0,
  credit: 0,
  unpaid: 600,
});
const STATEMENT = {
  asOf: "2026-10-31",
  customer: { id: "c1", businessName: "Acme Co" },
  openBalance: 1234.56,
  overdue: 600,
  creditAvailable: 0,
  afterCredit: 0,
  waitingToClear: 0,
  openInvoices: [inv(1), inv(2)],
  recentPayments: [],
  recentPaymentsTruncated: false,
  credits: [],
};

let failRead = false;
beforeEach(() => {
  failRead = false;
  mockBuyerGet.mockReset();
  mockBuyerGet.mockImplementation((url: string) => {
    if (url === "/buyer/account-statement") {
      return failRead ? Promise.reject(new Error("boom")) : Promise.resolve({ data: STATEMENT });
    }
    if (url === "/buyer/account-statement/pdf") return Promise.resolve({ data: { url: SIGNED } });
    if (url === "/buyer/statement")
      return Promise.resolve({ data: { outstandingAmount: 1234.56 } });
    return Promise.resolve({ data: {} });
  });
  mockStaffGet.mockReset();
  mockFetchBlob.mockReset().mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
  mockPrint.mockReset();
});

const tap = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("open-balance-button"));
  return user;
};
const sheet = () => screen.findByRole("dialog", { name: "Statement" });

describe("BP1: tap the Outstanding figure", () => {
  it("opens the sheet with the open balance equal to the figure, to the cent", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    expect(screen.getByTestId("open-balance-button")).toHaveTextContent("$1,234.56");
    await tap();
    const dialog = await sheet();
    expect(await within(dialog).findByTestId("account-statement-open-balance")).toHaveTextContent(
      "$1,234.56",
    );
    expect(within(dialog).getAllByText("Open balance").length).toBeGreaterThan(0);
    expect(mockBuyerGet).toHaveBeenCalledWith("/buyer/account-statement");
  });

  it("reads nothing until the tap: no statement GET while the sheet is closed", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    await act(async () => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockBuyerGet).not.toHaveBeenCalled();
    await tap();
    await screen.findByTestId("account-statement-open-balance");
    expect(mockBuyerGet).toHaveBeenCalledWith("/buyer/account-statement");
  });

  it("never touches the staff client", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    await tap();
    await screen.findByTestId("account-statement-open-balance");
    expect(mockStaffGet).not.toHaveBeenCalled();
  });

  it("shows the open invoices as plain numbers: no link out of the portal", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    await tap();
    const dialog = await sheet();
    expect(await within(dialog).findByText("INV-001")).toBeInTheDocument();
    expect(within(dialog).queryAllByRole("link")).toHaveLength(0);
  });

  it("Esc closes the sheet and focus returns to the figure", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    const user = await tap();
    await screen.findByTestId("account-statement-open-balance");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("open-balance-button")).toHaveFocus();
  });

  it("a failed read says so with Try Again, never a $0.00", async () => {
    failRead = true;
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    await tap();
    const dialog = await sheet();
    expect(await within(dialog).findByText("Couldn't load the statement.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(within(dialog).queryByText("$0.00")).toBeNull();
  });

  it("the reopened sheet reads again (the stale statement is cleared on close)", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    const user = await tap();
    await screen.findByTestId("account-statement-open-balance");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    mockBuyerGet.mockClear();
    mockBuyerGet.mockImplementation(() => new Promise(() => undefined));
    await user.click(screen.getByTestId("open-balance-button"));
    const dialog = await sheet();
    expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
    expect(mockBuyerGet).toHaveBeenCalledWith("/buyer/account-statement");
  });

  it("closing refreshes the Outstanding figure behind it", async () => {
    function Card() {
      const { data } = useBuyerStatement();
      const text = data ? `$${data.outstandingAmount.toFixed(2)}` : "…";
      return <BuyerOpenBalanceButton>{text}</BuyerOpenBalanceButton>;
    }
    renderWithProviders(<Card />);
    await waitFor(() =>
      expect(screen.getByTestId("open-balance-button")).toHaveTextContent("$1234.56"),
    );
    const user = await tap();
    await screen.findByTestId("account-statement-open-balance");
    mockBuyerGet.mockImplementation((url: string) =>
      Promise.resolve({
        data: url === "/buyer/statement" ? { outstandingAmount: 1000 } : STATEMENT,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-balance-button")).toHaveTextContent("$1000.00"),
    );
  });
});

describe("BP2: the buyer's actions", () => {
  it("Print is the only action: no Email, no staff tags", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    await tap();
    const dialog = await sheet();
    const actions = await within(dialog).findByTestId("account-statement-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim()),
    ).toEqual(["Print"]);
    expect(within(dialog).queryByRole("button", { name: /email/i })).toBeNull();
    expect(within(dialog).queryByText(/to collect|cash|zelle/i)).toBeNull();
  });

  it("Print asks the buyer print route and hands the bytes to the printer, through the buyer client", async () => {
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    const user = await tap();
    const dialog = await sheet();
    await user.click(await within(dialog).findByRole("button", { name: "Print" }));
    await waitFor(() => expect(mockPrint).toHaveBeenCalledTimes(1));
    expect(mockBuyerGet).toHaveBeenCalledWith("/buyer/account-statement/pdf");
    expect(mockFetchBlob).toHaveBeenCalledWith(SIGNED, buyerApiClient);
    expect(mockStaffGet).not.toHaveBeenCalled();
  });

  it("a failed print leaves the sheet and its figures in place", async () => {
    mockBuyerGet.mockImplementation((url: string) =>
      url === "/buyer/account-statement"
        ? Promise.resolve({ data: STATEMENT })
        : Promise.reject(new Error("render failed")),
    );
    renderWithProviders(<BuyerOpenBalanceButton>$1,234.56</BuyerOpenBalanceButton>);
    const user = await tap();
    const dialog = await sheet();
    await user.click(await within(dialog).findByRole("button", { name: "Print" }));
    await screen.findByText("Couldn't print the statement");
    expect(within(dialog).getByTestId("account-statement-open-balance")).toHaveTextContent(
      "$1,234.56",
    );
    await act(async () => undefined);
  });
});
