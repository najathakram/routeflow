import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import ExpensesPage from "./page";

/**
 * UXG-R10 C5 PR-2: below md the supplier bills list is a card list (bill number, supplier,
 * status, balance due, with the dates, total and paid on the last line and a checkbox for the
 * bulk actions), the table is md and up only, the KPI tiles are one sideways row, search stays
 * outside the Filters panel and the sort control sits beside the Filters button.
 */

const mockPush = jest.fn();
let mockSearch = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  usePathname: () => "/vendor-bills",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("@/lib/page-title-context", () => ({
  usePageTitle: () => ({ setTitle: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: {} }), post: jest.fn() },
}));
jest.mock("@/components/ScanInvoiceModal", () => ({ ScanInvoiceModal: () => null }));

const mockUseBills = jest.fn();
jest.mock("@/lib/api/vendor-bills", () => ({
  ...jest.requireActual("@/lib/api/vendor-bills"),
  useVendorBills: (...a: unknown[]) => mockUseBills(...a),
  useCreateVendorBill: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBulkDeleteVendorBills: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/inventory", () => ({
  ...jest.requireActual("@/lib/api/inventory"),
  useSuppliers: () => ({ data: { data: [] } }),
  usePurchaseOrders: () => ({ data: { data: [] } }),
}));

const PAST = "2020-01-05T00:00:00.000Z";
const FUTURE = "2099-01-05T00:00:00.000Z";

function makeBill(overrides: Record<string, unknown>) {
  return {
    supplierId: "sup-1",
    supplier: { id: "sup-1", name: "Acme Supply" },
    status: "RECEIVED",
    billDate: "2026-01-05T00:00:00.000Z",
    dueDate: FUTURE,
    totalOwed: 200,
    totalPaid: 50,
    items: [{ id: "i1", productId: "p1" }],
    createdAt: "2026-01-05T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

const BILLS = [
  makeBill({ id: "b-a", billNumber: "BILL-A" }),
  makeBill({
    id: "b-b",
    billNumber: "BILL-B",
    supplier: { id: "sup-2", name: "Acme Dairy" },
    status: "PAID",
    totalOwed: 80,
    totalPaid: 80,
    purchaseOrder: { id: "po-1", poNumber: "PO-7" },
  }),
  makeBill({
    id: "b-c",
    billNumber: "BILL-C",
    status: "DRAFT",
    dueDate: PAST,
    totalOwed: 30,
    totalPaid: 0,
    items: [],
  }),
];

const cardList = (container: HTMLElement) =>
  within(container.querySelector("ul.md\\:hidden") as HTMLElement).getAllByRole("listitem");

describe("Supplier bills list — phone cards", () => {
  beforeEach(() => {
    mockSearch = "";
    mockPush.mockClear();
    mockUseBills.mockReset();
    mockUseBills.mockImplementation((params?: { limit?: number }) => ({
      data: {
        data: BILLS,
        meta: {
          total: 3,
          page: 1,
          limit: params?.limit ?? 20,
          totalPages: 1,
          needsMappingCount: 1,
        },
      },
      isLoading: false,
      isError: false,
    }));
  });

  it("renders one card per bill with supplier, status and the balance due", () => {
    const { container } = renderWithProviders(<ExpensesPage />);
    const cards = cardList(container);
    expect(cards).toHaveLength(3);
    // Sorted by bill date, newest first, like the table: all three share a date, so keep order.
    const byTitle = (t: string) =>
      cards.find((c) => within(c).queryByRole("link", { name: t })) as HTMLElement;
    const a = byTitle("BILL-A");
    expect(within(a).getByRole("link", { name: "BILL-A" })).toHaveAttribute(
      "href",
      "/vendor-bills/b-a",
    );
    expect(within(a).getByText("Acme Supply")).toBeInTheDocument();
    expect(within(a).getByText("Received")).toBeInTheDocument();
    // Balance due = total owed minus paid; the total and paid are on the same card.
    expect(within(a).getByText("$150.00")).toBeInTheDocument();
    expect(within(a).getByText(/Total \$200\.00/)).toBeInTheDocument();
    expect(within(a).getByText(/Paid \$50\.00/)).toBeInTheDocument();
    const b = byTitle("BILL-B");
    expect(within(b).getByText("Paid")).toBeInTheDocument();
    expect(within(b).getByText("$0.00")).toBeInTheDocument();
    expect(within(b).getByText(/PO PO-7/)).toBeInTheDocument();
  });

  it("tones the balance danger only where the table does, and marks overdue like the table", () => {
    const { container } = renderWithProviders(<ExpensesPage />);
    const cards = cardList(container);
    const byTitle = (t: string) =>
      cards.find((c) => within(c).queryByRole("link", { name: t })) as HTMLElement;
    expect(within(byTitle("BILL-A")).getByText("$150.00").className).toContain("text-danger");
    expect(within(byTitle("BILL-B")).getByText("$0.00").className).not.toContain("text-danger");
    const c = byTitle("BILL-C");
    expect(within(c).getByText("$30.00").className).toContain("text-danger");
    expect(within(c).getByText("Overdue")).toBeInTheDocument();
    expect(within(c).getByText("needs items")).toBeInTheDocument();
    expect(within(byTitle("BILL-A")).queryByText("Overdue")).toBeNull();
    // The table: same rule on the same rows.
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    const rowFor = (n: string) => rows.find((r) => within(r).queryByText(n)) as HTMLElement;
    const tableBalance = (n: string, v: string) =>
      within(rowFor(n))
        .getAllByText(v)
        .find((el) => el.className.includes("font-medium")) as HTMLElement;
    expect(tableBalance("BILL-A", "$150.00").className).toContain("text-danger");
    expect(tableBalance("BILL-B", "$0.00").className).not.toContain("text-danger");
  });

  it("has no row action but the card link; each card has a bulk-select checkbox", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ExpensesPage />);
    const cards = cardList(container);
    expect(within(cards[0]).queryByRole("button", { name: /View bill/ })).toBeNull();
    const box = within(cards[0]).getByRole("checkbox", { name: /^Select BILL-/ });
    expect(box.closest("label")!.className).toContain("h-11");
    await user.click(box);
    // The bulk bar the table also uses appears and counts the selection.
    expect(screen.getByText("1 bill selected")).toBeInTheDocument();
    expect(box).toBeChecked();
    // Select all on the page, the table header's control, is on the phone too (once selecting).
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    expect(screen.getByText("3 bills selected")).toBeInTheDocument();
  });

  it("shows the table only from md up", () => {
    renderWithProviders(<ExpensesPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
  });

  it("scrolls the KPI tiles sideways in one row below md with Due This Week among the first two", () => {
    renderWithProviders(<ExpensesPage />);
    const row = screen.getByText("Open bills").closest("[data-kpi-row]") as HTMLElement;
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("snap-x");
    expect(row.className).toContain("md:grid");
    expect(row.className).toContain("lg:grid-cols-4");
    const cells = Array.from(row.querySelectorAll("[data-kpi-cell]")) as HTMLElement[];
    expect(cells).toHaveLength(4);
    for (const c of cells) {
      expect(c.className).toContain("shrink-0");
      expect(c.className).toContain("w-[46%]");
      expect(c.className).toContain("md:order-none");
    }
    const order = (label: string) =>
      (within(row).getByText(label).closest("[data-kpi-cell]") as HTMLElement).className.split(" ");
    expect(order("Open bills")).toContain("order-1");
    expect(order("Due This Week")).toContain("order-2");
    // DOM order is unchanged.
    expect(cells.map((c) => c.textContent?.slice(0, 5))).toEqual([
      "Open ",
      "Due T",
      "Unlin",
      "Spend",
    ]);
  });

  it("keeps search outside the Filters panel; the count ignores it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExpensesPage />);
    const search = screen.getByPlaceholderText(/Search by bill #/) as HTMLElement;
    const button = screen.getByRole("button", { name: "Filters" });
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel).not.toContainElement(search);
    expect(search.className).toContain("w-full");
    expect(panel).toContainElement(screen.getByLabelText("Status"));
    expect(panel).toContainElement(screen.getByLabelText("From"));
    expect(panel).toContainElement(screen.getByLabelText("To"));
    await user.type(search, "acme");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "PAID");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
  });

  it("clears the dates with a text button inside the panel", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExpensesPage />);
    await user.type(screen.getByLabelText("From"), "2026-01-01");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear dates" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("has a phone sort control beside the Filters button; the direction button says what a tap does", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExpensesPage />);
    const select = screen.getByLabelText("Sort bills by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["billDate", "Bill date"],
      ["supplier", "Supplier"],
      ["dueDate", "Due date"],
      ["total", "Total"],
      ["status", "Status"],
    ]);
    const filters = screen.getByRole("button", { name: "Filters" });
    expect((select.closest("div.md\\:hidden") as HTMLElement).parentElement).toBe(
      filters.parentElement,
    );
    const dir = screen.getByRole("button", { name: "Sort ascending" });
    expect(dir.className).toContain("h-11");
    expect(dir.className).toContain("w-11");
    await user.click(dir);
    expect(screen.getByRole("button", { name: "Sort descending" })).toBeInTheDocument();
  });

  it("puts the tab strip in one sideways-scrolling row and hides the descriptions below md", () => {
    renderWithProviders(<ExpensesPage />);
    const tab = screen.getByRole("button", { name: /Purchase orders/ });
    const strip = tab.parentElement as HTMLElement;
    const classes = (el: HTMLElement) => el.className.split(" ");
    expect(classes(strip)).toContain("max-md:overflow-x-auto");
    expect(classes(strip)).not.toContain("overflow-x-auto");
    expect(classes(strip)).not.toContain("snap-x");
    expect(classes(strip)).not.toContain("flex-wrap");
    expect(classes(tab)).toContain("max-md:shrink-0");
    expect(classes(tab)).toContain("max-md:whitespace-nowrap");
    expect(classes(tab)).not.toContain("shrink-0");
    expect(classes(tab)).not.toContain("whitespace-nowrap");
    expect(tab.className).toContain("min-h-[44px]");
    for (const re of [/One hub for supplier bills/, /Inventory purchases are recorded/]) {
      const el = screen.getByText(re);
      expect(el.className).toContain("hidden");
      expect(el.className).toContain("md:block");
    }
  });

  it("keeps the desktop filter bar: status select and the date group are separate items of the bar", () => {
    renderWithProviders(<ExpensesPage />);
    const search = screen.getByLabelText("Search bills") as HTMLElement;
    const bar = search.parentElement as HTMLElement;
    expect(bar.className).toContain("md:flex-wrap");
    const status = screen.getByLabelText("Status");
    const dateFrom = screen.getByLabelText("From");
    const dateTo = screen.getByLabelText("To");
    // The bar's direct item for a control: the first element, going up, that takes a box.
    const itemOf = (control: HTMLElement) => {
      let node = control.parentElement as HTMLElement;
      while (node !== bar && node.className.includes("md:contents")) {
        node = node.parentElement as HTMLElement;
      }
      // Reaching the bar means only md:contents wrappers sat above the control: it is the item.
      if (node === bar) return control;
      // Everything between that item and the bar must take no box from md up.
      let up = node.parentElement as HTMLElement;
      while (up !== bar) {
        expect(up.className).toContain("md:contents");
        up = up.parentElement as HTMLElement;
      }
      return node;
    };
    const statusItem = itemOf(status);
    const fromItem = itemOf(dateFrom);
    // The status select is its own item; the date group is another, shared by From and To.
    expect(statusItem).toBe(status);
    expect(fromItem).toBe(itemOf(dateTo));
    expect(fromItem).not.toBe(status);
    expect(fromItem.className).toContain("md:items-center");
  });

  it("shows Select all on this page below md only once a bill is selected", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ExpensesPage />);
    expect(screen.queryByRole("checkbox", { name: "Select all on this page" })).toBeNull();
    await user.click(
      within(cardList(container)[0]).getByRole("checkbox", { name: /^Select BILL-/ }),
    );
    const all = screen.getByRole("checkbox", { name: "Select all on this page" });
    expect(all.closest("label")!.className).toContain("md:hidden");
    expect(all.closest("label")!.textContent).toBe("Select all on this page");
  });

  it("uses the invoices phone tile markup: compact padding and value, hint clamped to two lines", () => {
    renderWithProviders(<ExpensesPage />);
    const tile = screen.getByText("Open bills").parentElement as HTMLElement;
    expect(tile.className).toContain("p-3");
    expect(tile.className).toContain("md:p-4");
    const value = tile.querySelector("span.money") as HTMLElement;
    expect(value.className).toContain("text-xl");
    expect(value.className).toContain("md:text-2xl");
    expect(value.className).toContain("md:mt-1.5");
    const hint = screen.getByText(/bills? unpaid/) as HTMLElement;
    expect(hint.className).toContain("line-clamp-2");
    expect(hint.className).toContain("md:line-clamp-none");
  });

  it("makes the bulk bar controls 44px tall below md only", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ExpensesPage />);
    await user.click(
      within(cardList(container)[0]).getByRole("checkbox", { name: /^Select BILL-/ }),
    );
    const controls = [
      screen.getByRole("button", { name: "Deselect all" }),
      screen.getByTitle("Payment method"),
      screen.getByTitle("Payment date"),
      screen.getByRole("button", { name: /Delete/ }),
      screen.getByRole("button", { name: /^Mark [0-9]+ paid/ }),
    ];
    for (const el of controls) {
      expect(el.className.split(" ")).toContain("max-md:min-h-[44px]");
      expect(el.className.split(" ")).not.toContain("min-h-[44px]");
    }
  });

  it("keeps the table visible and renders no cards or sort while empty", () => {
    mockUseBills.mockReturnValue({
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
    const { container } = renderWithProviders(<ExpensesPage />);
    const wrapper = screen.getByRole("table").closest("div.overflow-hidden") as HTMLElement;
    expect(wrapper.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(container.querySelector("ul.md\\:hidden")).toBeNull();
    expect(screen.queryByLabelText("Sort bills by")).toBeNull();
  });

  it("uses the contents filter panel layout (its controls stay direct items of the bar)", () => {
    renderWithProviders(<ExpensesPage />);
    const button = screen.getByRole("button", { name: /^Filters/ });
    const root = button.parentElement!.parentElement as HTMLElement;
    const panel = document.getElementById(button.getAttribute("aria-controls")!) as HTMLElement;
    expect(panel.parentElement).toBe(root);
    expect(root.className.split(" ")).toContain("md:contents");
  });
});
