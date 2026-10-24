import * as React from "react";
import { act, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2, PriceSaveStatus } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider, usePriceDraftOptional } from "./PriceDraftProvider";
import { PriceEditBar } from "./PriceEditBar";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";

// K11-20a: the seams a second editing surface (the floating price window) needs. One draft, two surfaces; only one of
// them edits at a time; the ids, the bar and the saved line each know which surface they belong to.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
const mockSave = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: mockSave, reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

let draft!: PriceDraft;
const Probe = () => {
  draft = usePriceDraft();
  return null;
};
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const ids = (): string[] => [...document.querySelectorAll("[id]")].map((e) => e.id);
const dups = (list: string[]) => list.filter((id, i) => list.indexOf(id) !== i);
const inputsIn = (el: HTMLElement) => el.querySelectorAll('[data-testid^="units-v2-input-"]');

beforeEach(() => {
  mockGrid = { data: GRID, isLoading: false, isError: false };
  mockSave.mockReset();
});

describe("K11-20a: one provider, two consumers", () => {
  it("startEditing(cell, 'window') edits in the window instance only; the inline one then refuses", () => {
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <div data-testid="inline">
            <EditablePricesGrid product={PRODUCT} />
          </div>
          <div data-testid="win">
            <EditablePricesGrid product={PRODUCT} surface="window" layout="table" />
          </div>
        </PriceDraftProvider>,
      ),
    );
    const inline = screen.getByTestId("inline");
    const win = screen.getByTestId("win");
    expect(draft.editingIn).toBeNull();
    // The window instance never shows Edit or the Editing pill; the inline one keeps its Edit.
    expect(within(win).queryByTestId(T.btnEdit)).toBeNull();
    expect(within(inline).getByTestId(T.btnEdit)).toBeTruthy();

    let first: boolean | undefined;
    act(() => {
      first = draft.startEditing({ ref: "case", tier: 2, layout: "table" }, "window");
    });
    expect(first).toBe(true);
    expect(draft.editingIn).toBe("window");
    expect(draft.editing).toBe(true);
    expect(inputsIn(win).length).toBeGreaterThan(0);
    expect(inputsIn(inline)).toHaveLength(0);
    expect(within(inline).queryByTestId(T.editingPill)).toBeNull();
    expect(within(win).queryByTestId(T.editingPill)).toBeNull();

    let second: boolean | undefined;
    act(() => {
      second = draft.startEditing(undefined, "inline");
    });
    expect(second).toBe(false);
    expect(draft.editingIn).toBe("window");
    expect(inputsIn(inline)).toHaveLength(0);
  });

  it("with both grids mounted and the window editing, no id repeats and the inline grid owns the title id", () => {
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <div data-testid="inline">
            <EditablePricesGrid product={PRODUCT} />
          </div>
          <div data-testid="win">
            <EditablePricesGrid product={PRODUCT} surface="window" layout="table" />
          </div>
        </PriceDraftProvider>,
      ),
    );
    act(() => {
      draft.startEditing({ ref: "case", tier: 2, layout: "table" }, "window");
    });
    // A problem line and an Auto word carry ids too: give one cell a problem so those render as well.
    act(() => {
      draft.editCell("case", 2, "abc");
    });
    expect(dups(ids())).toEqual([]);
    const title = document.getElementById("units-v2-grid-title");
    expect(title).not.toBeNull();
    expect(screen.getByTestId("inline")).toContainElement(title);
    expect(screen.getByTestId("win")).not.toContainElement(title);
  });
});

describe("K11-20a: entering edit mode keeps the focused input stable (window)", () => {
  it("the window instance takes focus on the box the start asked for, and keeps it while typing", async () => {
    const user = userEvent.setup();
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={PRODUCT} surface="window" layout="table" />
        </PriceDraftProvider>,
      ),
    );
    act(() => {
      draft.startEditing({ ref: "box", tier: 3, layout: "table" }, "window");
    });
    const box = screen.getByTestId(T.input("box", 3));
    expect(document.activeElement).toBe(box);
    await user.keyboard("20");
    expect(screen.getByTestId(T.input("box", 3))).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it("a box whose text changed since it took focus says so (data-escape-reverts) until it is put back", async () => {
    const user = userEvent.setup();
    rtlRender(wrap(<ProductPricingV2 product={PRODUCT} />));
    await user.click(screen.getByTestId(T.btnEdit));
    const box = within(screen.getByTestId(T.row("case"))).getByTestId(
      T.input("case", 2),
    ) as HTMLInputElement;
    act(() => box.focus());
    expect(box.hasAttribute("data-escape-reverts")).toBe(false);
    await user.keyboard("28");
    expect(box.hasAttribute("data-escape-reverts")).toBe(true);
    await user.keyboard("{Escape}");
    expect(box.hasAttribute("data-escape-reverts")).toBe(false);
  });
});

describe("K11-20a: the Edit bar knows its placement", () => {
  const mount = (mainContent = true) => {
    const tree = (
      <PriceDraftProvider productId="p1">
        <Probe />
        <EditablePricesGrid product={PRODUCT} surface="window" layout="table" />
        <PriceEditBar placement="window" />
      </PriceDraftProvider>
    );
    return rtlRender(wrap(mainContent ? <div id="main-content">{tree}</div> : tree));
  };

  it("placement window: no sticky class, #main-content scroll padding untouched, no Skip to Save link", () => {
    mount();
    act(() => {
      draft.startEditing({ ref: "case", tier: 2, layout: "table" }, "window");
    });
    const bar = screen.getByTestId(T.editbar);
    expect(bar.className).not.toMatch(/\bsticky\b/);
    expect(bar.style.bottom).toBe("");
    expect(
      document.getElementById("main-content")!.style.getPropertyValue("scroll-padding-bottom"),
    ).toBe("");
    expect(screen.queryByText("Skip to Save")).toBeNull();
    expect(screen.queryByTestId(T.skipSave)).toBeNull();
  });

  it("the window bar shows only while the window edits; the page bar only while the page edits", () => {
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <div data-testid="page">
            <PriceEditBar />
          </div>
          <div data-testid="win">
            <PriceEditBar placement="window" />
          </div>
        </PriceDraftProvider>,
      ),
    );
    act(() => {
      draft.startEditing(undefined, "window");
    });
    expect(within(screen.getByTestId("win")).queryByTestId(T.editbar)).not.toBeNull();
    expect(within(screen.getByTestId("page")).queryByTestId(T.editbar)).toBeNull();
    act(() => draft.discard());
    act(() => {
      draft.startEditing(undefined, "inline");
    });
    expect(within(screen.getByTestId("page")).queryByTestId(T.editbar)).not.toBeNull();
    expect(within(screen.getByTestId("win")).queryByTestId(T.editbar)).toBeNull();
  });

  it("the page bar is unchanged: sticky, with the Skip to Save link", async () => {
    const user = userEvent.setup();
    rtlRender(
      wrap(
        <div id="main-content">
          <ProductPricingV2 product={PRODUCT} />
        </div>,
      ),
    );
    await user.click(screen.getByTestId(T.btnEdit));
    expect(screen.getByTestId(T.editbar).className).toMatch(/\bsticky\b/);
    expect(screen.getByText("Skip to Save")).toBeTruthy();
    expect(document.getElementById(T.ebSave)).not.toBeNull();
  });

  it("the discard question focuses Keep editing, and Keep editing hands focus back to Cancel", async () => {
    const user = userEvent.setup();
    rtlRender(wrap(<ProductPricingV2 product={PRODUCT} />));
    await user.click(screen.getByTestId(T.btnEdit));
    await user.type(within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2)), "1");
    await user.click(screen.getByTestId(T.ebCancel));
    // A fresh node: autoFocus only runs on a new one, and a reused Cancel node would keep focus while reading Discard.
    expect(screen.getByTestId(T.ebKeep)).toHaveFocus();
    expect(screen.getByTestId(T.ebDiscard)).not.toHaveFocus();
    await user.click(screen.getByTestId(T.ebKeep));
    expect(screen.getByTestId(T.ebCancel)).toHaveFocus();
  });

  it("the window bar's Save id is suffixed so it never repeats the page's", () => {
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <PriceEditBar />
          <PriceEditBar placement="window" idSuffix="-w1" />
        </PriceDraftProvider>,
      ),
    );
    act(() => {
      draft.startEditing(undefined, "window");
    });
    expect(document.getElementById(`${T.ebSave}-w1`)).not.toBeNull();
    expect(document.getElementById(T.ebSave)).toBeNull();
  });
});
