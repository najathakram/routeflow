import * as React from "react";
import { act, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// K11-12: price boxes read as money. A "$" sits inside the box, a valid price settles to two decimals on blur, focus
// selects the whole value so typing replaces it, and Escape puts the box back to what it held when it took focus.

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
const caseRow = () => within(screen.getByTestId(T.row("case")));
const box = (tier: number) => caseRow().getByTestId(T.input("case", tier)) as HTMLInputElement;
const enter = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByTestId(T.btnEdit));
const bar = () => screen.getByTestId(T.ebText).textContent ?? "";

beforeEach(() => {
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("K11-12: a price box reads as money", () => {
  it("a Set 30 box shows 30.00 with a $ inside its border; an Auto box starts empty", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    expect(box(2).value).toBe("30.00");
    expect(box(1).value).toBe("1,800.00");
    expect(box(3).value).toBe("");
    const prefix = screen.getByTestId(T.inputPrefix("case", 2, "table"));
    expect(prefix.textContent).toBe("$");
    expect(prefix.getAttribute("aria-hidden")).toBe("true");
    expect(prefix.parentElement).toContainElement(box(2));
  });

  it("typed text settles to two decimals on blur, and a typed value equal to the saved one is not a change", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    await user.clear(box(3));
    await user.type(box(3), "29");
    expect(box(3).value).toBe("29");
    await user.tab();
    expect(box(3).value).toBe("29.00");
    expect(bar()).toContain("1 unsaved");
    // typing the saved price back (as "30") settles to the saved text and the draft count drops
    await user.clear(box(2));
    await user.type(box(2), "30");
    await user.tab();
    expect(box(2).value).toBe("30.00");
    expect(bar()).toContain("1 unsaved");
  });

  it("an invalid text is left as typed with its problem shown", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    await user.clear(box(3));
    await user.type(box(3), "abc");
    await user.tab();
    expect(box(3).value).toBe("abc");
    expect(box(3).getAttribute("aria-invalid")).toBe("true");
  });

  it("focus selects the whole value, so typing replaces it (28, not 30.0028)", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    act(() => box(2).focus());
    expect(box(2).selectionStart).toBe(0);
    expect(box(2).selectionEnd).toBe("30.00".length);
    await user.keyboard("28");
    expect(box(2).value).toBe("28");
  });
});

describe("K11-12: Escape puts a box back", () => {
  it("Escape restores the text the box had when it took focus and the draft count drops", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    act(() => box(2).focus());
    await user.keyboard("28");
    expect(bar()).toContain("1 unsaved");
    await user.keyboard("{Escape}");
    expect(box(2).value).toBe("30.00");
    expect(bar()).toContain("Nothing changed yet");
  });

  it("when Escape changed the text it stops there; on an untouched box it reaches the page's handler", async () => {
    const user = userEvent.setup();
    render();
    await enter(user);
    const page = jest.fn();
    document.addEventListener("keydown", page);
    act(() => box(2).focus());
    await user.keyboard("28{Escape}");
    expect(page.mock.calls.filter(([e]) => (e as KeyboardEvent).key === "Escape")).toHaveLength(0);
    page.mockClear();
    await user.keyboard("{Escape}");
    expect(page.mock.calls.filter(([e]) => (e as KeyboardEvent).key === "Escape")).toHaveLength(1);
    document.removeEventListener("keydown", page);
  });
});
