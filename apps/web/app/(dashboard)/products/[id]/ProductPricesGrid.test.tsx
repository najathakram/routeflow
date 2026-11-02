import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import { setWideViewport } from "@/test-utils/viewport";

setWideViewport();

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

describe("SA-1082: the Piece row with no unit behind it yet", () => {
  // The API serves the CASE's barcode on this row; a piece must not look like it scans with it.
  const CASE_CODE = "200000000007";
  const unbacked = {
    ref: "base",
    label: "Piece",
    factor: 1,
    kind: "base" as const,
    editable: true,
    unbacked: true,
    code: CASE_CODE,
    cells: cells([1.5, 1.4, 1.3, 1.2, 1.1]),
  };
  const withRow = (over: Record<string, unknown> = {}) => {
    mockGrid = {
      data: { ...grid, anchor: "case", rows: [grid.rows[0], { ...unbacked, ...over }] },
      isLoading: false,
      isError: false,
    };
  };
  const SURFACES = [T.row("base"), T.card("base")];

  it("W-1: it shows its Auto figures, in the table and the card", () => {
    withRow();
    render(<ProductPricesGrid product={product} />);
    for (const id of SURFACES) {
      const row = within(screen.getByTestId(id));
      expect(row.getByText("$1.50")).toBeTruthy();
      expect(row.getAllByText("Auto")).toHaveLength(5);
      expect(row.getByText("Smallest unit")).toBeTruthy();
    }
    const [cell] = screen.getAllByTestId(T.cell("base", 2));
    expect(cell.getAttribute("aria-label")).toBe("Wholesale Piece price, $1.40");
  });

  it("W-1: its barcode shows a dash, never the case code", () => {
    withRow();
    render(<ProductPricesGrid product={product} />);
    for (const id of SURFACES) {
      const scope = within(screen.getByTestId(id));
      expect(scope.getByTestId(T.code("base")).textContent).toBe("—");
      expect(scope.queryByText(CASE_CODE)).toBeNull();
      expect(scope.queryByText("No barcode")).toBeNull();
    }
  });

  it("W-1: compact density: the Unit cell's second line has no case code", () => {
    withRow();
    render(<ProductPricesGrid product={product} layout="table" density="compact" />);
    const row = within(screen.getByTestId(T.row("base")));
    expect(row.getByTestId(T.code("base")).textContent).toBe("—");
    expect(row.getByRole("rowheader").textContent).toContain("Smallest unit");
  });

  it("W-2: units flag off: figures and the sentence, and nothing to click", () => {
    withRow({
      editable: false,
      notEditableReason: "Follows the pack price. Selling by the piece isn't on for this business.",
    });
    render(<ProductPricesGrid product={product} />);
    for (const id of SURFACES) {
      const row = within(screen.getByTestId(id));
      expect(row.getByText("$1.50")).toBeTruthy();
      expect(row.getByTestId(T.notEditable("base")).textContent).toBe(
        "Follows the pack price. Selling by the piece isn't on for this business.",
      );
      expect(row.queryByRole("button")).toBeNull();
    }
  });

  it("a backed Piece keeps its own barcode", () => {
    withRow({ unbacked: undefined, code: "100000000001" });
    render(<ProductPricesGrid product={product} />);
    expect(within(screen.getByTestId(T.row("base"))).getByText("100000000001")).toBeTruthy();
  });

  it("a family-governed row with another reason keeps its prices", () => {
    withRow({
      unbacked: undefined,
      editable: false,
      notEditableReason: "Its price is set on the family.",
    });
    render(<ProductPricesGrid product={product} />);
    const row = within(screen.getByTestId(T.row("base")));
    expect(row.getByText("$1.50")).toBeTruthy();
    expect(row.getByTestId(T.notEditable("base")).textContent).toBe(
      "Its price is set on the family.",
    );
  });
});
