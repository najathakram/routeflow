import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K11-14: the save bar lines up with the grid card, the key hint is for wide screens, and an edit-mode caption says "Set" only.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 60,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([1800, 30, 28.5, 27, 26], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([30, 0.5, 0.48, 0.45, 0.43], ["set", "auto", "auto", "auto", "auto"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 60, pricePerUnit: "30" };
const render = () =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={product} />
    </QueryClientProvider>,
  );
const row = (ref: string) => within(screen.getByTestId(T.row(ref)));

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
});

const edit = async () => {
  const user = userEvent.setup();
  render();
  await user.click(screen.getByTestId(T.btnEdit));
  return user;
};

describe("K11-14: the save bar finishes the frame", () => {
  it("the bar has the grid card's inset and radius: no negative side margin, a rounded frame", async () => {
    await edit();
    const bar = screen.getByTestId(T.editbar);
    expect(bar.className).not.toMatch(/(^|\s)-?m[xlr]-/);
    expect(bar.className).toMatch(/\brounded-lg\b/);
    expect(bar.className).toMatch(/\bborder\b/);
    expect(bar.className).toMatch(/\bpx-4\b/);
    expect(screen.getByTestId(T.grid).className).toMatch(/\bp-4\b/);
  });

  it("the key hint shows from md up only (hidden below)", async () => {
    await edit();
    const hint = screen.getByTestId(T.ebHint);
    expect(hint.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(hint.className).toMatch(/\bmd:inline\b/);
    expect(hint.textContent).toMatch(/(Ctrl|⌘)\+?S saves/);
  });
});

describe("K11-14: the caption under a box says Set only", () => {
  it("a Set box keeps a visible Set caption", async () => {
    await edit();
    const cell = row("case").getByTestId(T.cell("case", 2));
    expect(within(cell).getByText("Set")).toBeVisible();
  });

  it("an Auto box shows no visible Auto word, and its description still says Auto", async () => {
    await edit();
    const cell = row("case").getByTestId(T.cell("case", 3));
    const words = within(cell).queryAllByText("Auto");
    // the only "Auto" left is the screen-reader description
    expect(words.every((w) => w.className.includes("sr-only"))).toBe(true);
    const input = within(cell).getByTestId(T.input("case", 3));
    expect(input).toHaveAccessibleDescription("Auto");
    expect(input.getAttribute("placeholder")).toBe("$28.50");
  });

  it("a Set box is not described as Auto", async () => {
    await edit();
    const input = row("case").getByTestId(T.input("case", 2));
    expect(input).not.toHaveAccessibleDescription(/Auto/);
  });
});
