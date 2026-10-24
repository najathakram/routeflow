import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerStatementCard } from "./customer-statement-card";

const get = jest.fn();
const toast = jest.fn();
const fetchPdfBlob = jest.fn();

jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
jest.mock("@/lib/fetch-pdf-blob", () => ({
  fetchPdfBlob: (...a: unknown[]) => fetchPdfBlob(...a),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const statement = {
  outstandingAmount: 125.5,
  overdueAmount: 0,
  availableCredit: 0,
  advanceBalance: 0,
  lifetimeInvoiced: 1000,
  lifetimeReceived: 874.5,
  transactionsTruncated: false,
  transactions: [
    {
      id: "t1",
      date: "2026-08-03T00:00:00.000Z",
      type: "INVOICE" as const,
      description: "INV-0001",
      amount: 125.5,
      runningBalance: 125.5,
    },
  ],
};

function renderCard(props: Partial<React.ComponentProps<typeof CustomerStatementCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomerStatementCard
        customerId="c1"
        statement={statement}
        statementFailed={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

const clicks: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) => {
    if (url === "/customers/c1/statements")
      return Promise.resolve({ data: { months: ["2026-09", "2026-08", "2026-07"] } });
    return Promise.resolve({ data: { url: "https://files.example/statement.pdf" } });
  });
  fetchPdfBlob.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
  clicks.length = 0;
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this.download);
  });
  (URL as any).createObjectURL = jest.fn(() => "blob:statement");
  (URL as any).revokeObjectURL = jest.fn();
});

describe("CustomerStatementCard (B1005, option A)", () => {
  it("shows no hard-coded letterhead, no made-up opening balance and no print button", () => {
    renderCard();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Austin/);
    expect(text).not.toMatch(/routeflow\.io/i);
    expect(text).not.toMatch(/RouteFlow/);
    expect(text).not.toMatch(/Opening Balance/i);
    expect(screen.queryByRole("button", { name: /^print$/i })).not.toBeInTheDocument();
  });

  it("while the statement is loading or failed, every money figure is an em dash, never $0.00", () => {
    for (const props of [
      { statement: undefined, statementFailed: false },
      { statement: undefined, statementFailed: true },
    ]) {
      const { unmount } = renderCard(props as any);
      const tiles = screen.getByTestId("statement-tiles").textContent ?? "";
      expect(tiles).not.toMatch(/\$0\.00/);
      expect((tiles.match(/—/g) ?? []).length).toBe(3);
      unmount();
    }
  });

  it("with data it shows the real invoiced, received and balance figures and keeps the ledger list", () => {
    renderCard();
    const tiles = screen.getByTestId("statement-tiles");
    expect(tiles).toHaveTextContent("$1,000.00");
    expect(tiles).toHaveTextContent("$874.50");
    expect(tiles).toHaveTextContent("$125.50");
    expect(screen.getByText("INV-0001")).toBeInTheDocument();
  });

  it("offers a chip per available month and downloads the server PDF for the SELECTED month", async () => {
    renderCard();
    const chip = await screen.findByRole("button", { name: /2026-07/ });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: /download statement/i }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/customers/c1/statements/2026-07"));
    expect(get).not.toHaveBeenCalledWith("/customers/c1/statements/2026-09");
    await waitFor(() =>
      expect(fetchPdfBlob).toHaveBeenCalledWith(
        "https://files.example/statement.pdf",
        expect.anything(),
      ),
    );
  });

  it("defaults to the newest month", async () => {
    renderCard();
    await screen.findByRole("button", { name: /2026-09/ });
    fireEvent.click(screen.getByRole("button", { name: /download statement/i }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/customers/c1/statements/2026-09"));
  });

  it("a failed download shows fixed copy, never the server message", async () => {
    get.mockImplementation((url: string) =>
      url === "/customers/c1/statements"
        ? Promise.resolve({ data: { months: ["2026-09"] } })
        : Promise.reject({
            response: { status: 500, data: { message: "pdf renderer exploded: secret" } },
          }),
    );
    renderCard();
    await screen.findByRole("button", { name: /2026-09/ });
    fireEvent.click(screen.getByRole("button", { name: /download statement/i }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = JSON.stringify(toast.mock.calls[0][0]);
    expect(arg).not.toMatch(/secret|exploded/);
    expect(arg).toMatch(/error/);
  });

  it("with no invoices yet (no months) the download is disabled and says why", async () => {
    get.mockImplementation(() => Promise.resolve({ data: { months: [] } }));
    renderCard();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /download statement/i })).toBeDisabled();
    expect(screen.getByText("No statements yet")).toBeInTheDocument();
  });

  it("a network failure says the download failed, never that it may have gone through", async () => {
    get.mockImplementation((url: string) =>
      url === "/customers/c1/statements"
        ? Promise.resolve({ data: { months: ["2026-09"] } })
        : Promise.reject(new Error("Network Error")),
    );
    renderCard();
    await screen.findByRole("button", { name: /2026-09/ });
    fireEvent.click(screen.getByRole("button", { name: /download statement/i }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const arg = toast.mock.calls[0][0];
    expect(arg.description).toBe("Couldn't download the statement. Try again.");
    expect(JSON.stringify(arg)).not.toMatch(/went through/);
  });
});
