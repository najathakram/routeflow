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

// K11-20a (draft): the seams a second editing surface (the floating price window) needs. One draft, two surfaces; only one of
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

describe("K11-20a: the draft owns which surface edits", () => {
  it("an inline start refuses the window in turn, and the default surface is inline", () => {
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
        </PriceDraftProvider>,
      ),
    );
    let a: boolean | undefined;
    act(() => {
      a = draft.startEditing();
    });
    expect(a).toBe(true);
    expect(draft.editingIn).toBe("inline");
    let b: boolean | undefined;
    act(() => {
      b = draft.startEditing(undefined, "window");
    });
    expect(b).toBe(false);
    expect(draft.editingIn).toBe("inline");
    // Starting the surface that already edits is fine (a second click on a price).
    let c: boolean | undefined;
    act(() => {
      c = draft.startEditing({ ref: "case", tier: 2, layout: "table" }, "inline");
    });
    expect(c).toBe(true);
    // Discarding frees the other surface.
    act(() => draft.discard());
    expect(draft.editingIn).toBeNull();
    act(() => {
      b = draft.startEditing(undefined, "window");
    });
    expect(b).toBe(true);
  });
});

describe("K11-20a: the optional provider hook and the outer provider", () => {
  it("usePriceDraftOptional is null outside a provider and exposes editingIn inside one", () => {
    let seen: PriceDraft | null | undefined;
    const Reader = () => {
      seen = usePriceDraftOptional();
      return null;
    };
    const { unmount } = rtlRender(<Reader />);
    expect(seen).toBeNull();
    unmount();
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Reader />
        </PriceDraftProvider>,
      ),
    );
    expect(seen).not.toBeNull();
    expect(seen!.editingIn).toBeNull();
    act(() => {
      seen!.startEditing();
    });
    expect(seen!.editingIn).toBe("inline");
  });

  it("ProductPricingV2 uses an outer provider when there is one (the page can read editingIn)", async () => {
    const user = userEvent.setup();
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <ProductPricingV2 product={PRODUCT} />
        </PriceDraftProvider>,
      ),
    );
    expect(draft.editingIn).toBeNull();
    await user.click(screen.getByTestId(T.btnEdit));
    // The outer draft is the one that edits, so the inline section is bound to it.
    expect(draft.editingIn).toBe("inline");
    expect(screen.getByTestId(T.editbar)).toBeTruthy();
    // Starting the window on the outer draft now refuses, and the section stays as it was.
    let r: boolean | undefined;
    act(() => {
      r = draft.startEditing(undefined, "window");
    });
    expect(r).toBe(false);
    expect(screen.getByTestId(T.editbar)).toBeTruthy();
  });

  it("ProductPricingV2 still creates its own provider when there is none", async () => {
    const user = userEvent.setup();
    rtlRender(wrap(<ProductPricingV2 product={PRODUCT} />));
    await user.click(screen.getByTestId(T.btnEdit));
    expect(screen.getByTestId(T.editbar)).toBeTruthy();
  });
});

describe("K11-20a: entering edit mode keeps the focused input stable", () => {
  it("a click on a price focuses its box once; typing keeps the same node focused", async () => {
    const user = userEvent.setup();
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <ProductPricingV2 product={PRODUCT} />
        </PriceDraftProvider>,
      ),
    );
    const table = screen.getByTestId(T.unitsTable);
    await user.click(
      within(table).getByRole("button", { name: /Edit Wholesale Case price, \$13\.91/ }),
    );
    expect(draft.editingIn).toBe("inline");
    const box = within(screen.getByTestId(T.row("case"))).getByTestId(
      T.input("case", 2),
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(box);
    // The whole value is selected (K11-12), and neither it nor focus moves when more renders happen.
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
    await user.keyboard("14");
    const after = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    expect(after).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("14");
  });
});

describe("K11-20a: a save knows its surface, and each status line shows only its own", () => {
  const mountStatus = () =>
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1">
          <Probe />
          <PriceSaveStatus productId="p1" surface="inline" />
          <PriceSaveStatus productId="p1" surface="window" />
        </PriceDraftProvider>,
      ),
    );
  const line = (surface: "inline" | "window") =>
    document.getElementById(surface === "inline" ? "units-msg" : "units-msg-window")!;
  const saveOnce = (surface: "inline" | "window") => {
    mockSave.mockImplementation((_req, o) => {
      mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
      o.onSuccess(SAVE_RESPONSE);
    });
    act(() => {
      draft.startEditing(undefined, surface);
    });
    act(() => {
      draft.editCell("case", 2, "14.5");
    });
    act(() => draft.save());
  };

  it("a window save records lastSave.surface 'window' and the inline line renders nothing for it", () => {
    mountStatus();
    saveOnce("window");
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(draft.lastSave?.surface).toBe("window");
    expect(line("inline").textContent).toBe("");
    expect(line("window").textContent).toContain("Saved");
    expect(within(line("window")).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("an inline save records 'inline' and the window line stays empty", () => {
    mountStatus();
    saveOnce("inline");
    expect(draft.lastSave?.surface).toBe("inline");
    expect(line("inline").textContent).toContain("Saved");
    expect(line("window").textContent).toBe("");
  });

  it("the next edit in either surface clears the saved line", () => {
    mountStatus();
    saveOnce("window");
    expect(line("window").textContent).toContain("Saved");
    act(() => {
      draft.startEditing(undefined, "inline");
    });
    expect(draft.lastSave).toBeNull();
    expect(line("window").textContent).toBe("");
  });

  it("the onSaved hook is told which surface saved", () => {
    const onSaved = jest.fn();
    rtlRender(
      wrap(
        <PriceDraftProvider productId="p1" onSaved={onSaved}>
          <Probe />
        </PriceDraftProvider>,
      ),
    );
    saveOnce("window");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ surface: "window" }));
  });
});
