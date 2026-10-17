import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockMsrpAddon = false;
let mockLabels: Record<string, string> = { "2": "Wholesale", "3": "Distributor" };
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: mockLabels }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => mockMsrpAddon }));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));

const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 0,
  priceState: "state-0",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      editable: true,
      code: "012345678905",
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      editable: true,
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

beforeEach(() => {
  mockMsrpAddon = false;
  mockLabels = { "2": "Wholesale", "3": "Distributor" };
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("ProductPricesGrid (S11, read-only)", () => {
  it("P02: the base price column is Retail by default and the tenant's own label when set, never Tier 1", () => {
    const { unmount } = render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(within(g).getAllByText("Retail").length).toBeGreaterThan(0);
    expect(g.textContent).not.toMatch(/Tier 1/);
    unmount();
    mockLabels = { "1": "Walk-in" };
    render(<ProductPricesGrid product={product} />);
    const g2 = screen.getByTestId(T.grid);
    expect(within(g2).getAllByText("Walk-in").length).toBeGreaterThan(0);
    expect(g2.textContent).not.toMatch(/Retail|Tier 1/);
  });

  it("T35: the header says Barcode and never SKU", () => {
    render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(within(g).getAllByText(/barcode/i).length).toBeGreaterThan(0);
    expect(g.textContent).not.toMatch(/SKU/i);
  });

  it("T37: Auto and Set appear as words", () => {
    render(<ProductPricesGrid product={product} />);
    expect(
      within(within(screen.getByTestId(T.row("piece"))).getByTestId(T.cell("piece", 1))).getByText(
        "Set",
      ),
    ).toBeTruthy();
    expect(
      within(within(screen.getByTestId(T.row("piece"))).getByTestId(T.cell("piece", 2))).getByText(
        "Auto",
      ),
    ).toBeTruthy();
  });

  it("formats the DTO value exactly: 0.92 renders $0.92", () => {
    render(<ProductPricesGrid product={product} />);
    expect(
      within(screen.getByTestId(T.row("piece"))).getByTestId(T.cell("piece", 1)).textContent,
    ).toContain("$0.92");
  });

  it("a pack Retail of 0 shows No price", () => {
    render(<ProductPricesGrid product={product} />);
    expect(
      within(screen.getByTestId(T.row("case"))).getByTestId(T.cell("case", 1)).textContent,
    ).toContain("No price");
  });

  it("uses the tenant's tier names and a price aria-label per cell", () => {
    render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(within(g).getAllByText("Wholesale").length).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId(T.row("case")))
        .getByTestId(T.cell("case", 2))
        .getAttribute("aria-label"),
    ).toBe("Wholesale Case price, $13.91");
  });

  it("shows barcode or No barcode, and Contains in plain words", () => {
    render(<ProductPricesGrid product={product} />);
    expect(within(screen.getByTestId(T.row("case"))).getByTestId(T.code("case")).textContent).toBe(
      "012345678905",
    );
    expect(within(screen.getByTestId(T.row("box"))).getByTestId(T.code("box")).textContent).toBe(
      "No barcode",
    );
    const row = screen.getByTestId(T.row("case"));
    expect(row.textContent).toContain("40 Boxes");
    expect(row.textContent).toContain("= 960 Pieces in all");
    expect(screen.getByTestId(T.row("piece")).textContent).toContain("Smallest unit");
  });

  it("the phone card carries the same ids as the table", () => {
    render(<ProductPricesGrid product={product} />);
    const card = within(screen.getByTestId(T.card("piece")));
    expect(card.getByTestId(T.cell("piece", 1)).textContent).toContain("$0.92");
    expect(card.getByTestId(T.code("piece")).textContent).toBe("No barcode");
  });

  it("shows a message when there are no units", () => {
    mockGrid = { data: { ...grid, rows: [] }, isLoading: false, isError: false };
    render(<ProductPricesGrid product={product} />);
    expect(screen.getByText("No units yet")).toBeTruthy();
  });

  it("is read only: no inputs or buttons in the grid", () => {
    render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(g.querySelectorAll("input, button, select, textarea").length).toBe(0);
  });

  it("MSRP line only with the product MSRP and add-on", () => {
    const { rerender } = render(<ProductPricesGrid product={{ ...product, msrp: "1.49" }} />);
    expect(screen.queryByText(/MSRP/)).toBeNull();
    mockMsrpAddon = true;
    rerender(<ProductPricesGrid product={{ ...product, msrp: "1.49" }} />);
    expect(screen.getByText(/MSRP/).textContent).toContain("$1.49 per Piece");
  });

  it("no S11 web file imports @routeflow/pricing (display only, no money math)", () => {
    const root = path.join(__dirname, "../../../..");
    const files = [
      path.join(__dirname, "ProductPricesGrid.tsx"),
      path.join(__dirname, "ProductPricingV2.tsx"),
      path.join(root, "lib/api/usePriceGrid.ts"),
    ];
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(/@routeflow\/pricing/);
    }
  });
});

describe("K11-11: a unit that does not exist yet shows no price", () => {
  const phantom = {
    ref: "base",
    label: "Piece",
    factor: 1,
    kind: "base" as const,
    editable: false,
    notEditableReason: "Add the Piece unit first.",
    code: null,
    cells: cells([1.5, 1.4, 1.3, 1.2, 1.1]),
  };
  const withPhantom = (over: Partial<typeof phantom> = {}) => {
    mockGrid = {
      data: { ...grid, anchor: "case", rows: [grid.rows[0], { ...phantom, ...over }] },
      isLoading: false,
      isError: false,
    };
  };
  let opener: jest.Mock;
  beforeEach(() => {
    opener = jest.fn();
    const b = document.body.appendChild(document.createElement("button"));
    b.setAttribute("data-testid", "units-v2-add-open");
    b.addEventListener("click", opener);
  });
  afterEach(() => {
    document.querySelectorAll('[data-testid="units-v2-add-open"]').forEach((n) => n.remove());
  });

  it("an implicit Piece row reads as dashes: no price, no Auto or Set word, in the table and the card", () => {
    withPhantom();
    render(<ProductPricesGrid product={product} />);
    for (const id of [T.row("base"), T.card("base")]) {
      const row = within(screen.getByTestId(id));
      expect(row.queryByText(/\$1\.\d\d/)).toBeNull();
      expect(row.queryByText(/^(Auto|Set)$/)).toBeNull();
      expect(row.getAllByText("—")).toHaveLength(5);
    }
    const [cell] = screen.getAllByTestId(T.cell("base", 2));
    expect(cell.getAttribute("aria-label")).toBe("Wholesale Piece price, no unit yet");
  });

  it("its head carries one 'Add Piece unit' button that asks the Add a unit opener to open", async () => {
    withPhantom();
    const user = userEvent.setup();
    render(<ProductPricesGrid product={product} />);
    const table = within(screen.getByTestId(T.row("base")));
    await user.click(table.getByRole("button", { name: "Add Piece unit" }));
    expect(opener).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByTestId(T.card("base"))).getByRole("button", { name: "Add Piece unit" }),
    ).toBeTruthy();
  });

  it("N7: the button is not part of the row header, so the header's name stays the unit name", () => {
    withPhantom();
    render(<ProductPricesGrid product={product} />);
    const row = within(screen.getByTestId(T.row("base")));
    const head = row.getByRole("rowheader");
    expect(head.textContent).not.toContain("Add Piece unit");
    expect(row.queryByRole("rowheader", { name: /Add Piece unit/ })).toBeNull();
    expect(row.getByRole("rowheader", { name: /^Piece/ })).toBe(head);
    const add = row.getByRole("button", { name: "Add Piece unit" });
    expect(add.closest("th")).toBeNull();
    expect(add.closest("td")).not.toBeNull();
    expect(add.closest("tr")).toBe(screen.getByTestId(T.row("base")));
    // the phone card keeps it, in the card
    expect(
      within(screen.getByTestId(T.card("base"))).getAllByRole("button", { name: "Add Piece unit" }),
    ).toHaveLength(1);
  });

  it("a family-governed row with another reason keeps its prices", () => {
    withPhantom({ notEditableReason: "Its price is set on the family." });
    render(<ProductPricesGrid product={product} />);
    const row = within(screen.getByTestId(T.row("base")));
    expect(row.getByText("$1.50")).toBeTruthy();
    expect(row.queryByRole("button", { name: /Add Piece unit/ })).toBeNull();
  });

  it("a non-base row with the same words is not treated as a missing unit", () => {
    withPhantom({ kind: "unit" as never });
    render(<ProductPricesGrid product={product} />);
    expect(within(screen.getByTestId(T.row("base"))).getByText("$1.50")).toBeTruthy();
  });
});
