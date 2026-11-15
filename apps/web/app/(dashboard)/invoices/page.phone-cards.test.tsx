import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, within, renderWithProviders } from "@/test-utils/render";
import InvoicesPage from "./page";

/**
 * UX guide improvement 12: below md the invoice list is a card list (one card per invoice, the
 * balance due from the page's own helper, every row action), the table is md and up only, and the
 * KPI tiles sit two per row.
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/invoices",
  useSearchParams: () => new URLSearchParams(),
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
    const cards = within(list).getAllByRole("link");
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
    // Sent invoice: view + print. Draft invoice: view + print + delete.
    expect(within(items[0]).getByRole("button", { name: /^View invoice/ })).toBeInTheDocument();
    expect(
      within(items[0]).getByRole("button", { name: "Print invoice INV-A" }),
    ).toBeInTheDocument();
    expect(within(items[0]).queryByRole("button", { name: /^Delete invoice/ })).toBeNull();
    expect(
      within(items[1]).getByRole("button", { name: "Delete invoice INV-B" }),
    ).toBeInTheDocument();
    expect(within(items[1]).getByRole("link")).not.toContainElement(
      within(items[1]).getByRole("button", { name: "Print invoice INV-B" }),
    );
  });

  it("shows the table only from md up", () => {
    renderWithProviders(<InvoicesPage />);
    const wrapper = screen.getByRole("table").closest("div.hidden") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("md:block");
  });

  it("lays the KPI tiles two per row below sm", () => {
    renderWithProviders(<InvoicesPage />);
    const tile = screen.getByText("Total outstanding");
    const grid = tile.closest("div.grid") as HTMLElement;
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.className).not.toContain("grid-cols-1");
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
      ["total", "Amount"],
    ]);
    const control = select.closest("div.md\\:hidden") as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.nextElementSibling).toBe(container.querySelector("ul.md\\:hidden"));
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();

    await user.selectOptions(select, "dueDate");
    const last = () => mockUseInvoices.mock.calls.at(-1)![0];
    expect(last()).toMatchObject({ sortBy: "dueDate", sortOrder: "asc" });
    await user.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect(last()).toMatchObject({ sortBy: "dueDate", sortOrder: "desc" });
    expect(screen.getByRole("button", { name: "Sort descending" })).toBeInTheDocument();
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
});
