import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "./ProductPricesGrid";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import { GRID, PRODUCT } from "./units-v2/window/k11-20a.fixtures";

// K11-20a: the grid's layout no longer has to follow the viewport. The floating price window measures its own width and
// asks for "table" or "cards"; "auto" (the default) is today's md: classes, so the inline grid is unchanged.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({ usePriceGrid: () => mockGrid }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));

const widthWas = window.innerWidth;
beforeEach(() => {
  mockGrid = { data: GRID, isLoading: false, isError: false };
  // A 1440 desktop: the viewport says "wide", so only the layout prop can ask for cards.
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
});
afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: widthWas,
  });
});

describe("K11-20a: layout prop", () => {
  it("layout='cards' renders cards and no table, even at 1440", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="cards" />);
    expect(screen.queryByTestId(T.unitsTable)).toBeNull();
    expect(screen.getAllByTestId(T.card("case"))).toHaveLength(1);
    expect(screen.getAllByTestId(T.card("piece"))).toHaveLength(1);
    // The card list is not hidden by a media query (no md:hidden), because the container decided.
    const card = screen.getByTestId(T.card("case"));
    expect(card.parentElement!.className).not.toMatch(/md:hidden/);
    expect(card.parentElement!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("layout='table' renders the table and no cards, and the table is not hidden below md", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" />);
    const region = screen.getByTestId(T.unitsTable);
    expect(screen.queryByTestId(T.card("case"))).toBeNull();
    expect(within(region).getByRole("columnheader", { name: "Unit" })).toBeTruthy();
    expect(region.parentElement!.parentElement!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(region.parentElement!.parentElement!.className).not.toMatch(/md:block/);
  });

  it("layout='auto' (and no layout at all) is today's markup: both, split by the md: classes", () => {
    const { unmount } = render(<ProductPricesGrid product={PRODUCT} />);
    expect(screen.getByTestId(T.unitsTable)).toBeTruthy();
    expect(screen.getByTestId(T.card("case")).parentElement!.className).toMatch(/md:hidden/);
    expect(screen.getByTestId(T.unitsTable).parentElement!.parentElement!.className).toMatch(
      /hidden md:block/,
    );
    unmount();
    render(<ProductPricesGrid product={PRODUCT} layout="auto" />);
    expect(screen.getByTestId(T.unitsTable)).toBeTruthy();
    expect(screen.getByTestId(T.card("case"))).toBeTruthy();
  });
});

describe("K11-20a: density compact", () => {
  it("folds Contains and the barcode into the Unit cell's second line and drops the Contains column", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" density="compact" />);
    const region = screen.getByTestId(T.unitsTable);
    expect(within(region).queryByRole("columnheader", { name: "Contains" })).toBeNull();
    const unit = within(screen.getByTestId(T.row("case"))).getByRole("rowheader");
    expect(unit.textContent).toContain("Case");
    expect(unit.textContent).toContain("40 Boxes · No barcode");
    const piece = within(screen.getByTestId(T.row("piece"))).getByRole("rowheader");
    expect(piece.textContent).toContain("Smallest unit · No barcode");
    // The barcode still has its own test id, so a barcode is read once per unit.
    expect(screen.getByTestId(T.code("case")).textContent).toBe("No barcode");
  });

  it("keeps the default density's Contains column", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" />);
    expect(screen.getByRole("columnheader", { name: "Contains" })).toBeTruthy();
  });

  it("the Unit column is pinned (sticky) so a scrolling table keeps it in view", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" density="compact" />);
    const head = screen.getByRole("columnheader", { name: "Unit" });
    expect(head.className).toMatch(/\bsticky\b/);
    expect(within(screen.getByTestId(T.row("case"))).getByRole("rowheader").className).toMatch(
      /\bsticky\b/,
    );
  });
});

describe("K11-20a: instance id suffix", () => {
  it("the default keeps today's ids exactly", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" />);
    expect(document.getElementById("units-v2-grid-title")).not.toBeNull();
    expect(screen.getByTestId(T.unitsTable).getAttribute("aria-labelledby")).toBe(
      "units-v2-grid-title",
    );
  });

  it("a suffix moves the title id and the table's label with it", () => {
    render(<ProductPricesGrid product={PRODUCT} layout="table" idSuffix="-w1" />);
    expect(document.getElementById("units-v2-grid-title")).toBeNull();
    const title = document.getElementById("units-v2-grid-title-w1");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Prices by unit");
    expect(screen.getByTestId(T.unitsTable).getAttribute("aria-labelledby")).toBe(
      "units-v2-grid-title-w1",
    );
  });
});
