/**
 * UX guide improvement 12 (C5 PR-3): below md the Stock list is a card list (one card per product with
 * its Current stock and stock status, every row action), the table is md and up only, the header keeps
 * the title and Quick restock on one row with the rest in a More menu, the tiles are one sideways row,
 * and a sort control sits above the cards. From md up nothing changes.
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, within, fireEvent } from "@testing-library/react";
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
let mockSearch = "";
jest.mock("@/lib/hooks/useUrlSearch", () => ({
  useUrlSearch: () => [mockSearch, jest.fn(), ""],
}));
let mockValuation: { totalValue: number; missingCostCount: number } | undefined;
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
  {
    // low (no reorder point, 3 <= 5), no cost, has variants: all four actions apply
    id: "p-all",
    name: "Acme Zed Kit",
    sku: "AZ-1",
    category: "Kits",
    unit: "each",
    currentStock: 3,
    averageCost: null,
    totalValue: null,
    isActive: true,
    unitsPerBox: null,
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
  useInventoryValuation: () => ({ data: mockValuation }),
  useBulkSetCostBasis: () => ({ mutate: jest.fn(), isPending: false }),
  useRecomputeCosts: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [
        { id: "p-out", parentProductId: null, variants: [] },
        { id: "p-ok", parentProductId: null, variants: [{ id: "v1" }] },
        { id: "p-all", parentProductId: null, variants: [{ id: "v2" }] },
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

function classTokens(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("InventoryPage: phone cards", () => {
  beforeEach(() => {
    mockSearch = "";
    mockValuation = undefined;
  });

  it("renders one card per product with its Current stock and stock status", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
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
    // The labels are the table headers' own words.
    expect(within(cards[0]).getByText(/^Unit cost \$2\.00$/)).toBeInTheDocument();
    expect(within(cards[0]).getByText(/^Total value \$48\.00$/)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/^Total value —$/)).toBeInTheDocument();
  });

  it("opens the product from the card title", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    const title = within(cards[0]).getByRole("link", { name: "Acme Boxed Gadget" });
    expect(title).toHaveAttribute("href", "/products/p-ok");
    // The plain "Open product" action is the card itself.
    expect(within(cards[0]).queryByRole("link", { name: "Open product" })).toBeNull();
  });

  it("sets the product name as a name, not as a record number", () => {
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    const title = within(cards[0]).getByRole("link", { name: "Acme Boxed Gadget" });
    expect(title.className).not.toContain("font-mono");
    // The SKU under it is the code: mono face, one step smaller and quieter than the name.
    const sku = within(cards[0]).getByText("AG-1", { exact: false });
    expect(sku.className).toContain("font-mono");
    expect(sku.className).toContain("text-xs");
    expect(sku.className).toContain("text-navy/70");
    expect(title.className).toContain("text-sm");
  });

  it("shows at most two text actions plus one More actions button, with every action reachable", async () => {
    const user = userEvent.setup();
    const { container } = render(<InventoryPage />);
    const cards = within(cardList(container)).getAllByRole("listitem");
    // [0] Boxed Gadget (cost, variants), [1] Widget (no cost, no variants), [2] Zed Kit (no cost, variants)
    for (const card of cards) {
      const buttons = within(card).getAllByRole("button");
      const more = buttons.filter((b) =>
        /^More actions for /.test(b.getAttribute("aria-label") ?? ""),
      );
      expect(more).toHaveLength(1);
      expect(more[0].className).toContain("min-h-[44px]");
      expect(more[0].className).toContain("min-w-[44px]");
      expect(buttons.length - 1).toBeLessThanOrEqual(2);
      expect(within(card).queryByRole("link", { name: "Movements" })).toBeNull();
    }
    const inline = (card: HTMLElement) =>
      within(card)
        .getAllByRole("button")
        .filter((b) => !b.getAttribute("aria-label"))
        .map((b) => b.textContent);
    expect(inline(cards[0])).toEqual(["Adjust"]);
    expect(inline(cards[1])).toEqual(["Set cost", "Adjust"]);
    expect(inline(cards[2])).toEqual(["Set cost", "Adjust"]);

    // The widest card (Zed Kit): Movements and Assign to variants are in its menu.
    await user.click(
      within(cards[2]).getByRole("button", { name: "More actions for Acme Zed Kit" }),
    );
    const menu = await screen.findAllByRole("menuitem");
    expect(menu.map((m) => m.textContent)).toEqual(["Movements", "Assign to variants"]);
    expect(menu[0]).toHaveAttribute("href", "/inventory/movements?product=p-all");
    await user.click(menu[1]);
    expect(screen.getByTestId("split-open")).toHaveTextContent("Acme Zed Kit");

    // A product with a cost: Adjust inline, Set cost in the menu (same handler).
    await user.click(
      within(cards[0]).getByRole("button", { name: "More actions for Acme Boxed Gadget" }),
    );
    const menu0 = await screen.findAllByRole("menuitem");
    expect(menu0.map((m) => m.textContent)).toEqual([
      "Set cost",
      "Movements",
      "Assign to variants",
    ]);
    await user.click(menu0[0]);
    expect(screen.getByTestId("set-cost-open")).toHaveTextContent("Acme Boxed Gadget");

    // One item in the menu still uses the menu (Widget has no variants).
    await user.click(
      within(cards[1]).getByRole("button", { name: "More actions for Acme Widget" }),
    );
    const menu1 = await screen.findAllByRole("menuitem");
    expect(menu1.map((m) => m.textContent)).toEqual(["Movements"]);
    await user.keyboard("{Escape}");

    await user.click(within(cards[1]).getByRole("button", { name: "Set cost" }));
    expect(screen.getByTestId("set-cost-open")).toHaveTextContent("Acme Widget");
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
    const tokens = classTokens(shell);
    expect(tokens).toEqual(expect.arrayContaining(["hidden", "md:block"]));
    // no bare display class that would show it on a phone
    for (const bad of ["block", "flex", "grid", "inline-block", "inline-flex"]) {
      expect(tokens).not.toContain(bad);
    }
    expect(within(table).getByText("Current stock")).toBeInTheDocument();
  });

  it("colours the table's Current stock cell out, low and ok from the one rule", () => {
    const { container } = render(<InventoryPage />);
    const table = container.querySelector("table") as HTMLElement;
    expect(within(table).getByText(/^0\b/).className).toContain("text-danger");
    const low = within(table).getByText(/^3\b/);
    expect(low.className).toContain("text-warning");
    const ok = within(table).getByText(/^24\b/);
    expect(ok.className).toContain("text-navy");
    expect(ok.className).not.toMatch(/text-(danger|warning)/);
  });

  it("lists Set Costs (n) in the phone More menu only when the count is above zero", async () => {
    const user = userEvent.setup();
    mockValuation = { totalValue: 48, missingCostCount: 2 };
    const first = render(<InventoryPage />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Set Costs (2)" })).toBeInTheDocument();
    first.unmount();
    mockValuation = { totalValue: 48, missingCostCount: 0 };
    render(<InventoryPage />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Adjust stock" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Set Costs/ })).toBeNull();
  });

  it("shrinks a large Stock Value figure below md and keeps text-2xl from md up", () => {
    mockValuation = { totalValue: 123456.78, missingCostCount: 0 };
    const { container } = render(<InventoryPage />);
    const cell = container.querySelectorAll("[data-kpi-cell]")[1] as HTMLElement;
    const figure = within(cell).getByText("$123,456.78");
    expect(classTokens(figure)).toEqual(expect.arrayContaining(["text-lg", "md:text-2xl"]));
    expect(classTokens(figure)).not.toContain("text-2xl");
  });

  it("the search suggestion list colours stock with the same rule as the table", () => {
    mockSearch = "acme";
    render(<InventoryPage />);
    fireEvent.focus(screen.getByPlaceholderText(/search by name, sku, or category/i));
    const list = screen.getByRole("listbox");
    expect(within(list).getByText(/^0 each$/).className).toContain("text-danger");
    expect(within(list).getByText(/^3 each$/).className).toContain("text-warning");
    expect(within(list).getByText(/^24 each$/).className).toContain("text-navy/70");
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
    expect(classTokens(search)).toEqual(expect.arrayContaining(["h-11", "md:h-9"]));
    expect(screen.queryByRole("button", { name: /^filters/i })).toBeNull();
  });

  it("has a phone sort control whose direction button says what a tap does", async () => {
    const user = userEvent.setup();
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<InventoryPage />);
    const select = screen.getByLabelText("Sort products by") as HTMLSelectElement;
    expect(select.value).toBe("name");
    const dir = screen.getByRole("button", { name: "Sort descending" });
    expect(dir.className).toContain("h-11");
    await user.click(dir);
    expect(screen.getByRole("button", { name: "Sort ascending" })).toBeInTheDocument();
    let cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[0]).getByText("Acme Zed Kit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect(screen.getByRole("button", { name: "Sort descending" })).toBeInTheDocument();
    await user.selectOptions(select, "currentStock");
    cards = within(cardList(container)).getAllByRole("listitem");
    expect(within(cards[0]).getByText("Acme Widget")).toBeInTheDocument();
    // no React warning (controlled/uncontrolled, unknown prop) from the select
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([]);
    errors.mockRestore();
  });
});
