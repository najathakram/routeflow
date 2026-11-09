import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import { setWideViewport } from "@/test-utils/viewport";

setWideViewport();

// W-1170 polish P28 (Auto boxes read "Follows Retail" while editing) and P29 (unit names capitalised, one empty barcode
// form). P3 and P5 are pinned in GridEdit.test.tsx and ProductPricesGrid.test.tsx.
let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "case",
  revision: 0,
  priceState: "state-0",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "case",
      factor: 24,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([36, 33, 36, 36, 36], ["set", "set"]),
    },
  ],
};
const product = { id: "p1", unit: "case", unitsPerBox: 24, pricePerUnit: "36" };
const edit = (editing: boolean) => ({
  editing,
  begin: jest.fn(),
  text: (_r: string, _t: number, original: string) => original,
  setText: jest.fn(),
  changed: () => false,
  problem: () => null,
  rows: null,
  focus: null,
  focused: jest.fn(),
});

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("W-1170 polish: price grid", () => {
  it("P29: a unit typed in lower case reads with a capital, and the empty barcode has one form", () => {
    render(<ProductPricesGrid product={product} layout="cards" />);
    const card = within(screen.getByTestId(T.card("case")));
    expect(card.getByText("Case")).toBeTruthy();
    expect(card.queryByText("case")).toBeNull();
    expect(card.getByTestId(T.code("case")).textContent).toBe("No barcode");
  });

  it("P28: while editing, an Auto tier box says it follows Retail; Set boxes and Retail itself do not", () => {
    render(<ProductPricesGrid product={product} layout="table" edit={edit(true)} />);
    const row = within(screen.getByTestId(T.row("case")));
    // tiers 3, 4 and 5 are Auto
    expect(row.getAllByText("Follows Retail")).toHaveLength(3);
  });

  it("P28: read mode keeps the plain Auto word", () => {
    render(<ProductPricesGrid product={product} layout="table" />);
    expect(screen.queryByText("Follows Retail")).toBeNull();
    expect(within(screen.getByTestId(T.row("case"))).getAllByText("Auto")).toHaveLength(3);
  });
});
