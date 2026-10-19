import * as React from "react";
import { render, screen, within } from "@testing-library/react";
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

afterEach(() => {
  // @ts-expect-error jsdom has no matchMedia
  delete window.matchMedia;
});

beforeEach(() => {
  mockMsrpAddon = false;
  mockLabels = {};
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("ProductPricesGrid layout (K13 P01, P04)", () => {
  it("P01: Contains is its own column when wide and sits under the unit name when narrower", () => {
    const { unmount } = render(<ProductPricesGrid product={product} />);
    expect(screen.getByTestId(T.grid).querySelector("thead tr")!.children).toHaveLength(7);
    expect(screen.queryByTestId(`${T.row("case")}-contains`)).toBeNull();
    unmount();
    const mm = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
    window.matchMedia = mm as unknown as typeof window.matchMedia;
    render(<ProductPricesGrid product={product} />);
    expect(mm).toHaveBeenCalledWith("(min-width: 1024px)");
    const head = screen.getByTestId(T.grid).querySelector("thead tr")!;
    expect(head.children).toHaveLength(6);
    expect(head.textContent).not.toMatch(/Contains/);
    expect(screen.getByTestId(T.row("case")).children).toHaveLength(6);
    expect(screen.getByTestId(`${T.row("case")}-contains`).textContent).toContain("40 Boxes");
  });

  it("P04: every cell, the pinned Unit cell included, carries the row rule except on the last row", () => {
    render(<ProductPricesGrid product={product} />);
    const g = screen.getByTestId(T.grid);
    const head = g.querySelector("thead tr")!;
    expect(head.className).toContain("[&>*]:border-b");
    const row = screen.getByTestId(T.row("case"));
    expect(row.className).toContain("[&>*]:border-b");
    expect(row.className).toContain("[&>*]:border-line-strong");
    expect(row.className).not.toMatch(/(^|\s)border-b(\s|$)/);
    expect(row.className).toContain("last:[&>*]:border-b-0");
  });
});
