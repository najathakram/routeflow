import * as React from "react";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { invoiceListItem } from "@/test-utils/buyer-invoice-fixtures";
import type { BuyerInvoiceListItem } from "@routeflow/types";
import BuyerInvoicesPage from "./page";

/**
 * Buyer-portal invoices list (B1122). The page used to read `totalAmount ?? amount`, but
 * GET /buyer/invoices carries the invoice's own `total` column, so every AMOUNT cell rendered
 * "N/A". The fixtures below are typed by @routeflow/types (the server's real row shape), so an
 * invented field name fails type-check instead of quietly passing.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push }),
}));

const mockGet = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

function respondWith(rows: BuyerInvoiceListItem[]) {
  mockGet.mockResolvedValue({
    data: { data: rows, meta: { total: rows.length, page: 1, limit: 20, totalPages: 1 } },
  });
}

/** The text of one row's cell under the named column header. */
function cell(row: HTMLElement, header: string): string {
  const table = screen.getByTestId("buyer-invoices-table");
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent?.trim());
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  return within(row).getAllByRole("cell")[idx].textContent?.trim() ?? "";
}

async function renderRows() {
  renderWithProviders(<BuyerInvoicesPage />);
  const table = await screen.findByTestId("buyer-invoices-table");
  // rows[0] is the header row
  return within(table).getAllByRole("row").slice(1);
}

describe("BuyerInvoicesPage — Amount and Balance (B1122)", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  it("shows each invoice's real `total` as money in the Amount column, never N/A", async () => {
    respondWith([
      invoiceListItem({ id: "i1", invoiceNumber: "INV-0001", total: 645, balanceDue: 645 }),
      invoiceListItem({
        id: "i2",
        invoiceNumber: "INV-0002",
        status: "PARTIAL",
        total: 1234.5,
        balanceDue: 234.5,
        paidAmount: 1000,
      }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("$645.00");
    expect(cell(rows[1], "Amount")).toBe("$1,234.50");
    expect(screen.queryByText("N/A")).toBeNull();
  });

  it("shows the server-derived `balanceDue` in the Balance column (0 for a settled invoice)", async () => {
    respondWith([
      invoiceListItem({ id: "i1", status: "PARTIAL", total: 120.5, balanceDue: 20.5 }),
      invoiceListItem({ id: "i2", status: "PAID", total: 80, balanceDue: 0, paidAmount: 80 }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Balance")).toBe("$20.50");
    expect(cell(rows[1], "Balance")).toBe("$0.00");
    expect(cell(rows[1], "Amount")).toBe("$80.00");
  });

  it("formats a money column that arrives as a Decimal string (the wire form today)", async () => {
    // Prisma's Decimal serialises as a string until the API serializer lands (DecimalWire).
    respondWith([
      invoiceListItem({
        total: "2500.00" as unknown as number,
        balanceDue: "999.99" as unknown as number,
      }),
    ]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("$2,500.00");
    expect(cell(rows[0], "Balance")).toBe("$999.99");
  });

  it("shows N/A only when the API really sent no amount", async () => {
    respondWith([
      { ...invoiceListItem(), total: undefined, balanceDue: undefined },
    ] as unknown as BuyerInvoiceListItem[]);
    const rows = await renderRows();

    expect(cell(rows[0], "Amount")).toBe("N/A");
    expect(cell(rows[0], "Balance")).toBe("N/A");
  });

  it("row click still opens the invoice", async () => {
    respondWith([invoiceListItem({ id: "i1", invoiceNumber: "INV-0001" })]);
    renderWithProviders(<BuyerInvoicesPage />);
    const table = await screen.findByTestId("buyer-invoices-table");
    within(table).getByText("INV-0001").click();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/buyer/portal/acme/invoices/i1"));
  });
});

describe("BuyerInvoicesPage — phone card list (B1122)", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  // At 390px the 6-column table scrolled sideways inside a 340px box, so Status, Amount and
  // Balance sat off-screen. Phones get one card per invoice (`sm:hidden`), as on the orders
  // list; the table stays from 640px up. JSDOM applies no media queries, so both trees are
  // present here and visibility is pinned by class and by the 390/768/1440 captures.
  it("renders one linked card per invoice with its number, status, real amount and balance", async () => {
    respondWith([
      invoiceListItem({
        id: "i1",
        invoiceNumber: "INV-0001",
        status: "PARTIAL",
        total: 1000,
        balanceDue: 750,
      }),
      invoiceListItem({
        id: "i2",
        invoiceNumber: "INV-0002",
        status: "PAID",
        total: 80,
        balanceDue: 0,
      }),
    ]);
    renderWithProviders(<BuyerInvoicesPage />);

    const cards = await screen.findByTestId("buyer-invoices-cards");
    expect(cards).toHaveClass("sm:hidden");
    const links = within(cards).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/buyer/portal/acme/invoices/i1");
    expect(within(links[0]).getByText("INV-0001")).toBeInTheDocument();
    expect(within(links[0]).getByText("Partial")).toHaveClass("bg-warning-bg");
    expect(within(links[0]).getByText("$1,000.00")).toBeInTheDocument();
    expect(within(links[0]).getByText("$750.00")).toBeInTheDocument();
    expect(within(links[1]).getByText("Paid")).toHaveClass("bg-success-bg");
    expect(within(links[1]).getByText("$80.00")).toBeInTheDocument();
    expect(within(links[1]).getByText("$0.00")).toBeInTheDocument();
    expect(within(links[0]).queryByText("N/A")).toBeNull();
  });

  it("labels the two money figures so the card is unambiguous", async () => {
    respondWith([invoiceListItem({ total: 645, balanceDue: 645 })]);
    renderWithProviders(<BuyerInvoicesPage />);

    const card = within(await screen.findByTestId("buyer-invoices-cards")).getByRole("link");
    expect(within(card).getByText("Amount")).toBeInTheDocument();
    expect(within(card).getByText("Balance")).toBeInTheDocument();
  });

  it("keeps the table from sm up", async () => {
    respondWith([invoiceListItem()]);
    renderWithProviders(<BuyerInvoicesPage />);

    const table = await screen.findByTestId("buyer-invoices-table");
    expect(table).toHaveClass("hidden", "sm:block");
  });
});

describe("BuyerInvoicesPage — empty and loading states", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  it("shows the empty state, not an empty table, when the buyer has no invoices", async () => {
    respondWith([]);
    renderWithProviders(<BuyerInvoicesPage />);

    expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
    expect(screen.getByText("Invoices from this seller will appear here.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByTestId("buyer-invoices-cards")).toBeNull();
    expect(screen.queryByTestId("buyer-invoices-loading")).toBeNull();
    // the list asked for the first page of this buyer's invoices
    expect(mockGet).toHaveBeenCalledWith("/buyer/invoices", { params: { page: 1, limit: 20 } });
  });

  it("shows a loading indicator, and neither the table nor the empty state, until the list arrives", async () => {
    let resolve!: (v: unknown) => void;
    mockGet.mockReturnValue(new Promise((r) => (resolve = r)));
    renderWithProviders(<BuyerInvoicesPage />);

    expect(await screen.findByTestId("buyer-invoices-loading")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("No invoices yet")).toBeNull();

    resolve({
      data: {
        data: [invoiceListItem({ invoiceNumber: "INV-0009" })],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
    });
    expect(await screen.findByTestId("buyer-invoices-table")).toBeInTheDocument();
    expect(screen.getAllByText("INV-0009").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("buyer-invoices-loading")).toBeNull();
  });
});

describe("BuyerInvoicesPage — status badge tones (B1122 fold, L-072)", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  /** The status pill of the row for `invoiceNumber`, found by the label it prints. */
  async function pill(label: string): Promise<HTMLElement> {
    const table = await screen.findByTestId("buyer-invoices-table");
    return within(table).getByText(label);
  }

  it("gives each REAL InvoiceStatus a deliberate tone: PARTIAL / SENT warning, PAID success, OVERDUE / VOID / WRITTEN_OFF danger", async () => {
    respondWith([
      invoiceListItem({ id: "i1", invoiceNumber: "INV-1", status: "PAID", balanceDue: 0 }),
      invoiceListItem({ id: "i2", invoiceNumber: "INV-2", status: "PARTIAL", balanceDue: 20 }),
      invoiceListItem({ id: "i3", invoiceNumber: "INV-3", status: "OVERDUE", isOverdue: true }),
      invoiceListItem({ id: "i4", invoiceNumber: "INV-4", status: "VOID", balanceDue: 0 }),
      invoiceListItem({ id: "i5", invoiceNumber: "INV-5", status: "WRITTEN_OFF", balanceDue: 0 }),
      invoiceListItem({ id: "i6", invoiceNumber: "INV-6", status: "SENT" }),
    ]);
    renderWithProviders(<BuyerInvoicesPage />);

    // Badge paints its tone as a bg class; the label is the formatted real status.
    expect(await pill("Paid")).toHaveClass("bg-success-bg");
    expect(await pill("Partial")).toHaveClass("bg-warning-bg");
    expect(await pill("Overdue")).toHaveClass("bg-danger-bg");
    expect(await pill("Void")).toHaveClass("bg-danger-bg");
    expect(await pill("Written Off")).toHaveClass("bg-danger-bg");
    expect(await pill("Sent")).toHaveClass("bg-warning-bg");
  });
});

describe("BuyerInvoicesPage — paid at sale shows no due date (row 401 follow-up)", () => {
  beforeEach(() => {
    push.mockClear();
    mockGet.mockReset();
  });

  const rows = () => [
    invoiceListItem({
      id: "till",
      invoiceNumber: "INV-TILL",
      status: "PAID",
      balanceDue: 0,
      paidAmount: 12,
      total: 12,
      paidAtSale: true,
    }),
    invoiceListItem({ id: "acct", invoiceNumber: "INV-ACCT", paidAtSale: false }),
  ];

  it("the table's Due Date cell is a dash for the till sale and the date for any other invoice", async () => {
    respondWith(rows());
    const body = await renderRows();
    expect(cell(body[0], "Due Date")).toBe("\u2014");
    expect(cell(body[1], "Due Date")).toBe("Oct 10, 2026");
  });

  it("the phone card drops ` · Due …` for the till sale only", async () => {
    respondWith(rows());
    renderWithProviders(<BuyerInvoicesPage />);
    await screen.findByTestId("buyer-invoices-table");
    const cards = screen.getAllByText(/Sep 10, 2026/).filter((el) => el.tagName === "P");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).not.toMatch(/Due/);
    expect(cards[1].textContent).toMatch(/Due Oct 10, 2026/);
  });
});
