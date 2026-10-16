import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen, within } from "@testing-library/react";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockMsrpAddon = false;
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
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
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      code: "012345678905",
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "box",
      label: "Box",
      factor: 24,
      kind: "unit",
      code: null,
      cells: cells([24.5, 22, 21, 20, 19]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

beforeEach(() => {
  mockMsrpAddon = false;
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("ProductPricesGrid (S11, read-only)", () => {
  it("T35: the header says Barcode and never SKU", () => {
    render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    expect(within(g).getAllByText("Barcode").length).toBeGreaterThan(0);
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
