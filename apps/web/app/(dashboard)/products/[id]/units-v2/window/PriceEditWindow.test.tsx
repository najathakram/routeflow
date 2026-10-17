import * as React from "react";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PriceSaveStatus, ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { PriceDraftProvider } from "../edit/PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "../edit/usePriceDraft";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "./k11-20a.fixtures";
import { PriceEditWindow } from "./PriceEditWindow";

// K11-20a: the floating price window, on the shared draft. jsdom lays nothing out, so geometry (placement, the real
// 560 px switch) is the Playwright spec's job (written, unrun); here the behaviour: one editor, ids, focus, Escape order,
// save and close, and the discard question.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
const mockSave = jest.fn();
let mockSaveOutcome: unknown = null;
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  // Stateful like the real mutation: `mutate` and `reset` replace `error`.
  useSavePrices: () => {
    const [after, setAfter] = jest.requireActual("react").useState(null) as [
      { error: unknown } | null,
      (a: { error: unknown } | null) => void,
    ];
    return {
      mutate: (req: unknown, o: unknown) => {
        mockSave(req, o);
        setAfter({ error: mockSaveOutcome });
      },
      reset: () => setAfter({ error: null }),
      isPending: false,
      error: after ? after.error : null,
    };
  },
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
const onClose = jest.fn();

function Harness({
  startOpen = true,
  focus,
  returnFocus,
}: {
  startOpen?: boolean;
  focus?: { ref: string; tier: number };
  returnFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = React.useState(startOpen);
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const [origin, setOrigin] = React.useState<HTMLElement | null>(null);
  const [qc] = React.useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      <PriceDraftProvider productId="p1">
        <Probe />
        <div ref={setAnchor} data-testid="card">
          <button ref={setOrigin} type="button" onClick={() => setOpen(true)}>
            Open price editor
          </button>
          <PriceSaveStatus productId="p1" surface="window" />
        </div>
        <div id="main-content">
          <ProductPricingV2 product={PRODUCT} />
        </div>
        <button type="button" onClick={() => setOpen(false)}>
          Close from outside
        </button>
        <PriceEditWindow
          product={PRODUCT}
          open={open}
          anchor={anchor}
          origin={origin}
          focus={focus}
          returnFocus={returnFocus}
          onClose={(reason) => {
            onClose(reason);
            setOpen(false);
          }}
        />
      </PriceDraftProvider>
    </QueryClientProvider>
  );
}

const render = (props: React.ComponentProps<typeof Harness> = {}) =>
  rtlRender(<Harness {...props} />);
const dialog = () => screen.getByRole("dialog", { name: "Edit prices" });
const inDialog = () => within(dialog());
const box = (ref: string, tier: number) =>
  within(dialog()).getByTestId(T.input(ref, tier)) as HTMLInputElement;
const inputsIn = (el: HTMLElement) => el.querySelectorAll('[data-testid^="units-v2-input-"]');
const ids = (): string[] => [...document.querySelectorAll("[id]")].map((e) => e.id);
const dups = (list: string[]) => list.filter((id, i) => list.indexOf(id) !== i);
// Radix arms its outside-press listener on a timer after mount.
const armed = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  mockGrid = { data: GRID, isLoading: false, isError: false };
  mockSave.mockReset();
  onClose.mockReset();
  mockSaveOutcome = null;
});

describe("K11-20a window: what it contains", () => {
  it("opens already editing: a dialog titled Edit prices, inputs in it, none in the inline grid", async () => {
    render();
    await screen.findByRole("dialog", { name: "Edit prices" });
    // Product name is only the sr-only description; the visible title stays short.
    expect(dialog()).toHaveAccessibleDescription("Acme widgets");
    expect(draft.editingIn).toBe("window");
    expect(inputsIn(dialog()).length).toBeGreaterThan(0);
    const outside = [...document.querySelectorAll('[data-testid^="units-v2-input-"]')].filter(
      (el) => !dialog().contains(el),
    );
    expect(outside).toHaveLength(0);
  });

  it("has Change prices, the order unit and the bar; not Edit, Editing, Add a unit, Reset, or the Customer view", async () => {
    render();
    await screen.findByRole("dialog", { name: "Edit prices" });
    const d = inDialog();
    expect(d.getByRole("button", { name: "Change prices" })).toBeTruthy();
    expect(d.getByTestId(T.orderUnit)).toBeTruthy();
    expect(d.getByTestId(T.editbar)).toBeTruthy();
    expect(d.queryByTestId(T.btnEdit)).toBeNull();
    expect(d.queryByTestId(T.editingPill)).toBeNull();
    expect(d.queryByText(/add a unit/i)).toBeNull();
    expect(d.queryByText(/reset all to auto/i)).toBeNull();
    expect(d.queryByText(/customer view/i)).toBeNull();
    // One bar on the page, and it is the window's.
    expect(screen.getAllByTestId(T.editbar)).toHaveLength(1);
  });

  it("the bar is pinned in the window: not sticky, no Skip to Save, #main-content untouched", async () => {
    render();
    await screen.findByRole("dialog", { name: "Edit prices" });
    const bar = inDialog().getByTestId(T.editbar);
    expect(bar.className).not.toMatch(/\bsticky\b/);
    expect(screen.queryByText("Skip to Save")).toBeNull();
    expect(
      document.getElementById("main-content")!.style.getPropertyValue("scroll-padding-bottom"),
    ).toBe("");
  });

  it("with the inline Change prices panel open behind it, no id repeats and the inline grid owns the title", async () => {
    const user = userEvent.setup();
    render({ startOpen: false });
    // The inline panel is open first (it is not editing yet); then the window opens over it and opens its own.
    await user.click(screen.getByTestId(T.btnChange));
    expect(document.getElementById("change-panel")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Open price editor" }));
    await screen.findByRole("dialog", { name: "Edit prices" });
    await user.click(inDialog().getByRole("button", { name: "Change prices" }));
    expect(inDialog().getByRole("region", { name: "Change prices" })).toBeTruthy();
    // A cell problem renders its own id too.
    act(() => {
      draft.editCell("case", 3, "abc");
    });
    expect(dups(ids())).toEqual([]);
    const title = document.getElementById("units-v2-grid-title")!;
    expect(title).not.toBeNull();
    expect(dialog().contains(title)).toBe(false);
    expect(dialog().contains(document.getElementById("change-panel"))).toBe(false);
    expect(dialog().contains(document.getElementById("btn-change-open"))).toBe(false);
  });

  it("refuses to open over an inline edit: it tells the caller 'cancel' and leaves the draft alone", async () => {
    render({ startOpen: false });
    act(() => {
      draft.startEditing(undefined, "inline");
    });
    act(() => {
      screen.getByRole("button", { name: "Open price editor" }).click();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("cancel"));
    expect(draft.editingIn).toBe("inline");
  });
});

describe("K11-20a window: initial focus and return focus", () => {
  it("opened on a price: that box has focus with its text selected", async () => {
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    expect(box("case", 2).selectionStart).toBe(0);
    expect(box("case", 2).selectionEnd).toBe(box("case", 2).value.length);
    expect(box("case", 2).value).toBe("13.91");
  });

  it("opened from the header trigger: the first editable box, never the close button", async () => {
    render();
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 1)).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
  });

  it("a clean close returns focus to the opener", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onClose).toHaveBeenCalledWith("cancel");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open price editor" })).toHaveFocus(),
    );
  });

  it("when the opener is gone, focus goes to the element the caller's returnFocus names", async () => {
    const user = userEvent.setup();
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    heading.textContent = "Units and prices";
    document.body.appendChild(heading);
    render({ returnFocus: () => heading });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(heading).toHaveFocus());
    heading.remove();
  });
});

describe("K11-20a window: layout comes from the window's own width", () => {
  class MockRO {
    static all: MockRO[] = [];
    cb: ResizeObserverCallback;
    els: Element[] = [];
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      MockRO.all.push(this);
    }
    observe(el: Element) {
      this.els.push(el);
    }
    unobserve() {}
    disconnect() {
      this.els = [];
    }
  }
  const was = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  beforeEach(() => {
    MockRO.all = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockRO;
  });
  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = was;
  });
  const widthIs = (w: number) =>
    act(() => {
      for (const ro of MockRO.all)
        for (const el of ro.els)
          ro.cb(
            [{ target: el, contentRect: { width: w } } as unknown as ResizeObserverEntry],
            ro as unknown as ResizeObserver,
          );
    });

  it("a body of 700 px shows the table, 400 px shows cards, and compact density folds Contains in", async () => {
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    widthIs(700);
    expect(inDialog().getByTestId(T.unitsTable)).toBeTruthy();
    expect(inDialog().queryByTestId(T.card("case"))).toBeNull();
    expect(inDialog().queryByRole("columnheader", { name: "Contains" })).toBeNull();
    expect(
      within(inDialog().getByTestId(T.row("case"))).getByRole("rowheader").textContent,
    ).toContain("40 Boxes · No barcode");
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    widthIs(400);
    expect(inDialog().queryByTestId(T.unitsTable)).toBeNull();
    expect(inDialog().getByTestId(T.card("case"))).toBeTruthy();
    widthIs(560);
    expect(inDialog().getByTestId(T.unitsTable)).toBeTruthy();
  });
});

describe("K11-20a window: Save", () => {
  it("Ctrl+S saves once (the draft's one listener)", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("14.5");
    fireEvent.keyDown(box("case", 2), { key: "s", ctrlKey: true });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toMatchObject({
      expectedRevision: 7,
      patches: [{ ref: "case", tier: 2, to: 14.5 }],
    });
  });

  it("a successful save closes with 'saved'; the line shows in the window's place, not the section's", async () => {
    mockSave.mockImplementation((_req, o) => {
      mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
      o.onSuccess(SAVE_RESPONSE);
    });
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("14.5");
    await user.click(inDialog().getByTestId(T.ebSave));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("saved"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(draft.lastSave?.surface).toBe("window");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.getElementById("units-msg-window")!.textContent).toContain("Saved");
    expect(document.getElementById("units-msg")!.textContent).toBe("");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open price editor" })).toHaveFocus(),
    );
  });

  it("a failed save keeps the window open with the error in the bar and the draft intact", async () => {
    mockSaveOutcome = { response: { status: 500, data: {} } };
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("14.5");
    await user.click(inDialog().getByTestId(T.ebSave));
    const alert = await inDialog().findByRole("alert");
    expect(inDialog().getByTestId(T.editbar)).toContainElement(alert);
    expect(onClose).not.toHaveBeenCalled();
    expect(draft.count).toBe(1);
    expect(box("case", 2).value).toBe("14.50"); // settled on blur
    expect(draft.editingIn).toBe("window");
  });

  it("a stale answer shows the stale notice in the bar, with Reload prices", async () => {
    mockSaveOutcome = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("14.5");
    await user.click(inDialog().getByTestId(T.ebSave));
    const bar = inDialog().getByTestId(T.editbar);
    expect(await within(bar).findByRole("button", { name: "Reload prices" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(draft.count).toBe(1);
  });
});

describe("K11-20a window: Escape order", () => {
  it("1. a box changed since focus: Escape puts it back and the window stays open", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("28");
    expect(box("case", 2).hasAttribute("data-escape-reverts")).toBe(true);
    await user.keyboard("{Escape}");
    expect(box("case", 2).value).toBe("13.91");
    expect(dialog()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard your unsaved changes?")).toBeNull();
  });

  it("2. Change prices open: Escape closes the panel and focuses Change prices; the window stays", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    const opener = inDialog().getByRole("button", { name: "Change prices" });
    await user.click(opener);
    expect(inDialog().getByRole("region", { name: "Change prices" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(inDialog().queryByRole("region", { name: "Change prices" })).toBeNull();
    expect(opener).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();
  });

  it("2b. only the window's own panel counts: an inline panel left open behind does not swallow Escape", async () => {
    const user = userEvent.setup();
    render({ startOpen: false });
    await user.click(screen.getByTestId(T.btnChange));
    await user.click(screen.getByRole("button", { name: "Open price editor" }));
    await screen.findByRole("dialog", { name: "Edit prices" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("cancel"));
    // The inline panel is still open: Escape was the window's.
    expect(document.getElementById("change-panel")).not.toBeNull();
  });

  it("4. clean draft: Escape closes with 'cancel' at once", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(draft.editingIn).toBeNull();
  });

  it("4 and 3. dirty draft: Escape asks, Keep editing is focused, a second Escape is Keep editing", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("28");
    await user.tab(); // settles the text; the next box has nothing to put back
    expect(box("case", 3)).toHaveFocus();
    expect(draft.dirty).toBe(true);
    await user.keyboard("{Escape}");
    expect(inDialog().getByText("Discard your unsaved changes?")).toBeTruthy();
    expect(inDialog().getByTestId(T.ebKeep)).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(inDialog().queryByText("Discard your unsaved changes?")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(draft.dirty).toBe(true);
    expect(box("case", 3)).toHaveFocus();
  });

  it("the discard question's Discard closes with 'discarded'", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("28");
    await user.tab();
    await user.keyboard("{Escape}");
    await user.click(inDialog().getByTestId(T.ebDiscard));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("discarded"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(draft.editingIn).toBeNull();
    expect(draft.dirty).toBe(false);
  });
});

describe("K11-20a window: closing with the X or the scrim", () => {
  it("dirty: the X asks, with Keep editing focused, and nothing is discarded", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await user.keyboard("28");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(inDialog().getByText("Discard your unsaved changes?")).toBeTruthy();
    expect(inDialog().getByTestId(T.ebKeep)).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(draft.dirty).toBe(true);
    await user.click(inDialog().getByTestId(T.ebKeep));
    expect(inDialog().queryByText("Discard your unsaved changes?")).toBeNull();
    expect(draft.dirty).toBe(true);
  });

  it("dirty: a click on the scrim asks too; clean: a scrim click closes at once", async () => {
    const user = userEvent.setup();
    render({ focus: { ref: "case", tier: 2 } });
    await screen.findByRole("dialog", { name: "Edit prices" });
    await waitFor(() => expect(box("case", 2)).toHaveFocus());
    await armed();
    const scrim = () => document.querySelector("[data-floating-panel-scrim]") as HTMLElement;
    await user.keyboard("28");
    fireEvent.pointerDown(scrim());
    expect(inDialog().getByText("Discard your unsaved changes?")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(inDialog().getByTestId(T.ebKeep));
    // Type the saved price back, so the draft is clean again.
    await user.clear(box("case", 2));
    await user.type(box("case", 2), "13.91");
    expect(draft.dirty).toBe(false);
    fireEvent.pointerDown(scrim());
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("cancel"));
  });
});

describe("K11-20a window: never a hidden draft", () => {
  it("closing it from outside while it edits leaves the inline Edit available", async () => {
    render();
    await screen.findByRole("dialog", { name: "Edit prices" });
    expect(draft.editingIn).toBe("window");
    fireEvent.click(screen.getByText("Close from outside"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(draft.editingIn).toBeNull();
    expect(screen.getByTestId(T.btnEdit)).toBeTruthy();
  });
});
