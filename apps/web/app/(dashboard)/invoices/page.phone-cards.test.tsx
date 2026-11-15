import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * UX guide improvement 12: below md the invoice list is a card list (one card per invoice, the
 * balance due from the page's own helper, every row action), the table is md and up only, and the
 * KPI tiles sit two per row.
 */

let mockSearchString = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(mockSearchString),
}));

jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "ADMIN" } }),
}));

function makeInvoice(overrides: Record<string, unknown>) {
  return {
    customerId: "cust-1",
    status: "SENT",
    subtotal: 100,
    total: 100,
    balanceDue: 40,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    issueDate: "2026-01-05T00:00:00.000Z",
    dueDate: "2099-02-05T00:00:00.000Z",
    customer: { businessName: "Acme Foods" },
    ...overrides,
  };
}

const mockUseInvoices = jest.fn();
const INVOICES = [
  makeInvoice({ id: "inv-a", invoiceNumber: "INV-A", balanceDue: 40 }),
  makeInvoice({
    id: "inv-b",
    invoiceNumber: "INV-B",
    status: "DRAFT",
    total: 75,
    balanceDue: 75,
    customer: { businessName: "Acme Bakery" },
  }),
];

jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoices: (...args: unknown[]) => mockUseInvoices(...args),
  useInvoiceKpiSummary: () => ({ data: undefined }),
  useDeleteInvoice: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/bookkeeping", () => ({
  ...jest.requireActual("@/lib/api/bookkeeping"),
  useBookkeepingSummary: () => ({ data: undefined }),
}));

describe("InvoicesPage — phone cards", () => {
  beforeEach(() => {
    mockSearchString = "";
    mockUseInvoices.mockReset();
    mockUseInvoices.mockReturnValue({
      data: { data: INVOICES, meta: { total: 2, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
  });

  it("renders one card per invoice with its balance due and status", () => {
    const { container } = renderWithProviders(<InvoicesPage />);
    const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
    expect(list).not.toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("INV-A")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Acme Foods")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Sent")).toBeInTheDocument();
    expect(within(cards[0]).getByText("$40.00")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Draft")).toBeInTheDocument();
    expect(within(cards[1]).getByText("$75.00")).toBeInTheDocument();
  });

  it("puts every row action on the card, outside the link", () => {
    const { container } = renderWithProviders(<InvoicesPage />);
    const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
    const items = within(list).getAllByRole("listitem");
    // A1-1: the card is the link, so no View action. Sent: print. Draft: print + delete.
    expect(within(items[0]).queryByRole("button", { name: /^View invoice/ })).toBeNull();
    expect(within(items[1]).queryByRole("button", { name: /^View invoice/ })).toBeNull();
    expect(
      within(items[0]).getByRole("button", { name: "Print invoice INV-A" }),
    ).toBeInTheDocument();
    expect(within(items[0]).queryByRole("button", { name: /^Delete invoice/ })).toBeNull();
    expect(
      within(items[1]).getByRole("button", { name: "Delete invoice INV-B" }),
    ).toBeInTheDocument();
    expect(
      within(items[1]).getByRole("button", { name: "Print invoice INV-B" }),
    ).toBeInTheDocument();
    // A1-2: the title is an anchor to the invoice page; the card root is not a link.
    const link = within(items[0]).getByRole("link", { name: "INV-A" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/invoices/inv-a");
    expect(items[0].querySelector("[data-record-card]")).not.toHaveAttribute("role");
    expect(items[0].querySelector("[role=link]")).toBeNull();
  });

  it("shows the table only from md up", () => {
    renderWithProviders(<InvoicesPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
  });

  it("scrolls the KPI tiles sideways in one row below md, a grid from md up (A1 D1)", () => {
    renderWithProviders(<InvoicesPage />);
    const tile = screen.getByText("Total outstanding");
    const scroller = tile.closest("[data-kpi-row]") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("snap-x");
    expect(scroller.className).toContain("md:grid");
    expect(scroller.className).toContain("lg:grid-cols-6");
    const cell = tile.closest("[data-kpi-cell]") as HTMLElement;
    expect(cell.className).toContain("shrink-0");
    expect(scroller.querySelectorAll("[data-kpi-cell]")).toHaveLength(6);
  });

  it("status tabs and due chips are one sideways-scrolling row each below md", () => {
    renderWithProviders(<InvoicesPage />);
    const tab = screen
      .getAllByRole("button", { name: "Overdue" })
      .find((el) => el.className.includes("border-b-2")) as HTMLElement;
    const tabs = tab.parentElement as HTMLElement;
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).toContain("snap-x");
    expect(tabs.className).not.toContain("flex-wrap");
    expect(tab.className).toContain("shrink-0");
    const chip = screen.getByRole("button", { name: "Due today" });
    const chips = chip.parentElement as HTMLElement;
    expect(chips.className).toContain("overflow-x-auto");
    expect(chips.className).not.toContain("flex-wrap");
    expect(chip.className).toContain("shrink-0");
  });

  it("has a phone sort control above the card list, outside the filters", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<InvoicesPage />);
    const select = screen.getByLabelText("Sort invoices by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["issueDate", "Date"],
      ["invoiceNumber", "Invoice #"],
      ["status", "Status"],
      ["dueDate", "Due Date"],
      ["total", "Total"],
    ]);
    // D1: the Filters button and the sort control share one row, both outside the panel.
    const filters = screen.getByRole("button", { name: "Filters" });
    const control = select.closest("div.md\\:hidden") as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.parentElement).toBe(filters.parentElement);
    expect(container.querySelector("ul.md\\:hidden")).not.toBeNull();

    await user.selectOptions(select, "dueDate");
    const last = () => mockUseInvoices.mock.calls.at(-1)![0];
    expect(last()).toMatchObject({ sortBy: "dueDate", sortOrder: "asc" });
    // A1-4: the name says what a tap does.
    const dir = screen.getByRole("button", { name: "Sort descending" });
    expect(dir.className).toContain("border");
    expect(dir.className).toContain("h-11");
    expect(dir.className).toContain("w-11");
    expect(dir.className).toContain("text-navy");
    expect(dir.className).not.toContain("text-navy/");
    expect(dir.querySelector("svg")!.getAttribute("class")).toContain("h-4");
    await user.click(dir);
    expect(last()).toMatchObject({ sortBy: "dueDate", sortOrder: "desc" });
    expect(screen.getByRole("button", { name: "Sort ascending" })).toBeInTheDocument();
  });

  it("A1-3: search is outside the Filters disclosure and does not count as a filter", () => {
    mockSearchString = "search=acme";
    renderWithProviders(<InvoicesPage />);
    const search = screen.getByPlaceholderText(/Search by invoice/) as HTMLElement;
    const button = screen.getByRole("button", { name: "Filters" });
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel).not.toContainElement(search);
    expect(panel).toContainElement(screen.getByTitle("Issue date from"));
    expect(search.className).toContain("w-full");
  });

  it("A1-3: a date filter still counts", () => {
    mockSearchString = "search=acme&dateFrom=2026-01-01";
    renderWithProviders(<InvoicesPage />);
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
  });

  it("A1-6: below md the three secondary actions are in the More menu; md up they are buttons", async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoicesPage />);
    for (const name of ["Export", "Payments Received", "Recurring"]) {
      const plain = screen.getByRole("button", { name });
      expect(plain.className).toContain("hidden");
      expect(plain.className).toContain("md:inline-flex");
    }
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more.className).toContain("md:hidden");
    expect(screen.getByRole("button", { name: /New invoice/ })).toBeInTheDocument();
    await user.click(more);
    expect(await screen.findByRole("menuitem", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Payments Received" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Recurring" })).toBeInTheDocument();
  });

  it("hides the page description below md", () => {
    renderWithProviders(<InvoicesPage />);
    const desc = screen.getByText(/Track receivables/);
    expect(desc.className).toContain("hidden");
    expect(desc.className).toContain("md:block");
  });

  it("does not render the sort control when there are no cards", () => {
    mockUseInvoices.mockReturnValue({
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<InvoicesPage />);
    expect(screen.queryByLabelText("Sort invoices by")).toBeNull();
  });

  it.each([
    ["loading", { data: undefined, isLoading: true, isError: false }],
    [
      "empty",
      {
        data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
        isLoading: false,
        isError: false,
      },
    ],
  ])("while %s, the table wrapper stays visible and no cards or sort render", (_n, state) => {
    mockUseInvoices.mockReturnValue(state);
    const { container } = renderWithProviders(<InvoicesPage />);
    const wrapper = screen.getByRole("table").closest("div.overflow-hidden") as HTMLElement;
    expect(wrapper.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(container.querySelector("ul.md\\:hidden")).toBeNull();
    expect(screen.queryByLabelText("Sort invoices by")).toBeNull();
  });

  it("card actions are 44px targets 8px apart; the table keeps its small buttons", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<InvoicesPage />);
    const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
    const draft = within(list).getAllByRole("listitem")[1];
    const big = (el: HTMLElement) => {
      expect(el.className).toContain("min-h-[44px]");
      expect(el.className).toContain("min-w-[44px]");
    };
    big(within(draft).getByRole("button", { name: /^Print invoice/ }));
    big(within(draft).getByRole("button", { name: "Delete invoice INV-B" }));
    const row = within(draft).getByRole("button", { name: /^Print invoice/ }).parentElement!;
    expect(row.className).toContain("gap-2");
    expect(row.parentElement!.className).toContain("relative");
    expect(row.parentElement!.className).toContain("z-10");

    await user.click(within(draft).getByRole("button", { name: "Delete invoice INV-B" }));
    big(within(draft).getByTitle("Confirm delete"));
    big(within(draft).getByTitle("Cancel"));
    expect(within(draft).getByTitle("Cancel").parentElement!.className).toContain("gap-2");
    // The confirm shows on that card only, and Cancel hides it.
    expect(within(list).getAllByTitle("Confirm delete")).toHaveLength(1);
    await user.click(within(draft).getByTitle("Cancel"));
    expect(within(draft).queryByTitle("Confirm delete")).toBeNull();

    const table = within(screen.getByRole("table"));
    for (const name of [/^View invoice/, /^Print invoice/]) {
      expect(table.getAllByRole("button", { name })[0].className).not.toContain("min-h-[44px]");
    }
    expect(table.getAllByRole("button", { name: /^View invoice/ })[0].className).toContain("p-1.5");
  });

  it("A1-5: the balance is danger only when the invoice is overdue, on the card and the table", () => {
    const past = "2020-01-05T00:00:00.000Z";
    const rows = [
      makeInvoice({ id: "i1", invoiceNumber: "T-SENT", status: "SENT", balanceDue: 11 }),
      makeInvoice({ id: "i2", invoiceNumber: "T-DRAFT", status: "DRAFT", balanceDue: 22 }),
      makeInvoice({ id: "i3", invoiceNumber: "T-PAID", status: "PAID", balanceDue: 0 }),
      makeInvoice({
        id: "i4",
        invoiceNumber: "T-OVER",
        status: "OVERDUE",
        balanceDue: 44,
        dueDate: past,
      }),
      makeInvoice({
        id: "i5",
        invoiceNumber: "T-PART",
        status: "PARTIAL",
        balanceDue: 55,
        dueDate: past,
      }),
    ];
    mockUseInvoices.mockReturnValue({
      data: { data: rows, meta: { total: 5, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
    const { container } = renderWithProviders(<InvoicesPage />);
    const cards = within(container.querySelector("ul.md\\:hidden") as HTMLElement).getAllByRole(
      "listitem",
    );
    expect(within(cards[0]).getByText("Balance Due")).toBeInTheDocument();
    const tone = (el: HTMLElement) => (el.className.includes("text-danger") ? "danger" : "default");
    const expected = ["default", "default", "default", "danger", "danger"];
    const amounts = ["$11.00", "$22.00", "$0.00", "$44.00", "$55.00"];
    amounts.forEach((amt, i) => {
      expect(tone(within(cards[i]).getByText(amt))).toBe(expected[i]);
    });
    const body = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    amounts.forEach((amt, i) => {
      const cell = within(body[i])
        .getAllByText(amt)
        .find((el) => el.className.includes("font-semibold"))!;
      expect(tone(cell)).toBe(expected[i]);
    });
  });
});
