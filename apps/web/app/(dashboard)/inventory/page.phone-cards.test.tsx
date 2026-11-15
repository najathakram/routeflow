/**
 * UX guide improvement 12 (C5 PR-3): below md the Stock list is a card list (one card per product with
 * its Current stock and stock status, every row action), the table is md and up only, the header keeps
 * the title and Quick restock on one row with the rest in a More menu, the tiles are one sideways row,
 * and a sort control sits above the cards. From md up nothing changes.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, within } from "@testing-library/react";
import InventoryPage from "./page";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/inventory",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlFilters", () => ({
  useUrlFilters: () => [{ section: "" }, jest.fn()],
}));
jest.mock("@/lib/hooks/useUrlSearch", () => ({ useUrlSearch: () => ["", jest.fn(), ""] }));
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));

const stockRows = [
  {
    id: "p-out",
    name: "Acme Widget",
    sku: "AW-1",
    category: "Parts",
    unit: "each",
    currentStock: 0,
    averageCost: null,
    totalValue: null,
    isActive: true,
    unitsPerBox: null,
  },
  {
    id: "p-ok",
    name: "Acme Boxed Gadget",
    sku: "AG-1",
    category: "Gadgets",
    unit: "each",
    currentStock: 24,
    reorderPoint: 6,
    averageCost: 2,
    totalValue: 48,
    isActive: true,
    unitsPerBox: 12,
  },
];

jest.mock("@/lib/api/inventory", () => ({
  useStockOverview: () => ({ data: stockRows, isLoading: false }),
  useSuppliers: () => ({ data: [], isLoading: false }),
  useRecordAdjustment: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateSupplier: () => ({ mutate: jest.fn(), isPending: false }),
  useForecasting: () => ({ data: [], isLoading: false }),
  useUpdateReorderSettings: () => ({ mutate: jest.fn(), isPending: false }),
  useInventoryValuation: () => ({ data: undefined }),
  useBulkSetCostBasis: () => ({ mutate: jest.fn(), isPending: false }),
  useRecomputeCosts: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [
        { id: "p-out", parentProductId: null, variants: [] },
        { id: "p-ok", parentProductId: null, variants: [{ id: "v1" }] },
      ],
    },
  }),
}));

jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));
jest.mock("@/components/RegulatedScopeTabs", () => ({ RegulatedScopeTabs: () => null }));
jest.mock("@/components/ScanInvoiceModal", () => ({ ScanInvoiceModal: () => null }));
jest.mock("@/components/inventory/StockCountTab", () => ({ StockCountTab: () => null }));
jest.mock("@/components/SetCostModal", () => ({
  SetCostModal: ({ item }: { item: { name: string } }) => (
    <div data-testid="set-cost-open">{item.name}</div>
  ),
}));
jest.mock("@/components/VariantSplitModal", () => ({
  VariantSplitModal: ({ parent }: { parent: { name: string } }) => (
    <div data-testid="split-open">{parent.name}</div>
  ),
}));
jest.mock("./_components/PurchaseOrdersCreateModal", () => ({ CreatePOModal: () => null }));
jest.mock("./_components/QuickRestockModal", () => ({
  QuickRestockModal: () => <div data-testid="restock-open" />,
}));

function cardList(container: HTMLElement): HTMLElement {
  const list = container.querySelector("ul.md\\:hidden") as HTMLElement;
  expect(list).not.toBeNull();
  return list;
}

describe("InventoryPage: phone cards", () => {
  it("renders one card per product with its Current stock and stock status", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    // sorted by name ascending: Boxed Gadget first
    expect(within(cards[0]).getByText("Acme Boxed Gadget")).toBeInTheDocument();
    expect(within(cards[0]).getByText("AG-1", { exact: false })).toBeInTheDocument();
    expect(within(cards[0]).getByText("Current stock")).toBeInTheDocument();
    expect(within(cards[0]).getByText(/^24\b/)).toBeInTheDocument();
    expect(within(cards[0]).getByText("In stock")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Acme Widget")).toBeInTheDocument();
    expect(within(cards[1]).getByText("Out of stock")).toBeInTheDocument();
    expect(within(cards[1]).getByText("No cost set")).toBeInTheDocument();
  });

  it("shows cost and value from the table's own helpers", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[0]).getByText(/\$2\.00/)).toBeInTheDocument();
    expect(within(cards[0]).getByText(/\$48\.00/)).toBeInTheDocument();
  });

  it("opens the product from the card title and keeps every other row action on the card", async () => {
    const user = userEvent.setup();
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    const title = within(cards[0]).getByRole("link", { name: "Acme Boxed Gadget" });
    expect(title).toHaveAttribute("href", "/products/p-ok");
    // The plain "Open product" action is the card itself.
    expect(within(cards[0]).queryByRole("link", { name: "Open product" })).toBeNull();
    expect(within(cards[0]).getByRole("button", { name: "Set cost" })).toBeInTheDocument();
    expect(within(cards[0]).getByRole("button", { name: "Adjust" })).toBeInTheDocument();
    expect(within(cards[0]).getByRole("link", { name: "Movements" })).toHaveAttribute(
      "href",
      "/inventory/movements?product=p-ok",
    );
    // Assign to variants only where the table shows it (a generic with variants).
    expect(
      within(cards[0]).getByRole("button", { name: "Assign to variants" }),
    ).toBeInTheDocument();
    expect(within(cards[1]).queryByRole("button", { name: "Assign to variants" })).toBeNull();

    await user.click(within(cards[1]).getByRole("button", { name: "Set cost" }));
    expect(screen.getByTestId("set-cost-open")).toHaveTextContent("Acme Widget");
    await user.click(within(cards[0]).getByRole("button", { name: "Assign to variants" }));
    expect(screen.getByTestId("split-open")).toHaveTextContent("Acme Boxed Gadget");
    await user.click(within(cards[0]).getByRole("button", { name: "Adjust" }));
    expect(screen.getByRole("button", { name: /save adjustment/i })).toBeInTheDocument();
  });

  it("marks only the out-of-stock amount in the danger tone, as the table does", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[1]).getByText(/^0\b/).className).toContain("text-danger");
    expect(within(cards[0]).getByText(/^24\b/).className).not.toContain("text-danger");
  });

  it("the stock table container is md and up only", () => {
    const { container } = render(<InventoryPage />);
    const table = container.querySelector("table") as HTMLElement;
    const shell = table.parentElement as HTMLElement;
    expect(shell.className).toContain("hidden");
    expect(shell.className).toContain("md:block");
    expect(within(table).getByText("Current stock")).toBeInTheDocument();
  });

  it("keeps the title and Quick restock on one row below md; the rest is in a More menu", async () => {
    const user = userEvent.setup();
    render(<InventoryPage />);
    const desc = screen.getByText(/Stock levels, cost basis/);
    expect(desc.className).toContain("hidden");
    expect(desc.className).toContain("md:block");
    const more = screen.getByRole("button", { name: "More actions" });
    expect(more.className).toContain("md:hidden");
    expect(more.parentElement?.className).toContain("md:hidden");
    const phoneRestock = within(more.parentElement as HTMLElement).getByRole("button", {
      name: /quick restock/i,
    });
    expect(phoneRestock.className).toContain("min-h-[44px]");
    // From md up the toolbar buttons are plain buttons as before.
    const toolbar = screen.getByTestId("stock-toolbar-actions");
    expect(toolbar.className).toContain("hidden");
    expect(toolbar.className).toContain("md:block");
    for (const name of [/^adjust stock$/i, /^add product$/i, /^scan invoice$/i]) {
      expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    }
    await user.click(more);
    expect(await screen.findByRole("menuitem", { name: "Adjust stock" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add product" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Scan invoice" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Adjust stock" }));
    expect(await screen.findByRole("button", { name: /save adjustment/i })).toBeInTheDocument();
  });

  it("shows the summary tiles as one sideways row below md, out of stock among the first two", () => {
    const { container } = render(<InventoryPage />);
    const row = container.querySelector("[data-kpi-row]") as HTMLElement;
    expect(row.className).toContain("snap-x");
    expect(row.className).toContain("overflow-x-auto");
    expect(row.className).toContain("md:grid");
    const cells = Array.from(row.querySelectorAll("[data-kpi-cell]")) as HTMLElement[];
    expect(cells).toHaveLength(3);
    // DOM order unchanged: Total Products, Stock Value, Out of Stock.
    expect(cells[0]).toHaveTextContent("Total Products");
    expect(cells[2]).toHaveTextContent("Out of Stock");
    expect(cells[2].className).toContain("order-1");
    expect(cells[2].className).toContain("md:order-none");
    expect(cells[0].className).toContain("order-2");
    expect(cells[1].className).toContain("order-3");
  });

  it("keeps search always visible and adds no Filters panel (only one filter control exists)", () => {
    render(<InventoryPage />);
    const search = screen.getByPlaceholderText(/search by name, sku, or category/i);
    expect(search.className).toContain("h-11");
    expect(screen.queryByRole("button", { name: /^filters/i })).toBeNull();
  });

  it("has a phone sort control whose direction button says what a tap does", async () => {
    const user = userEvent.setup();
    const { container } = render(<InventoryPage />);
    const select = screen.getByLabelText("Sort products by") as HTMLSelectElement;
    expect(select.value).toBe("name");
    const dir = screen.getByRole("button", { name: "Sort descending" });
    expect(dir.className).toContain("h-11");
    await user.click(dir);
    expect(screen.getByRole("button", { name: "Sort ascending" })).toBeInTheDocument();
    let cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[0]).getByText("Acme Widget")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect(screen.getByRole("button", { name: "Sort descending" })).toBeInTheDocument();
    await user.selectOptions(select, "currentStock");
    cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[0]).getByText("Acme Widget")).toBeInTheDocument();
  });
});
