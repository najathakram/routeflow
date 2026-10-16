import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { PriceEditBar } from "./PriceEditBar";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricesGrid } from "../../ProductPricesGrid";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import type { GridEditApi } from "./edit-types";
import { PLAN_TESTIDS } from "../change-prices/plan-testids";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockError: unknown = null;
const mockSave = jest.fn();
let mockFresh: ProductPriceGridDto = {} as ProductPriceGridDto;
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockFresh),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: mockSave, isPending: false, error: mockError }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
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
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
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
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const render = (ui: React.ReactElement, opts: Parameters<typeof rtlRender>[1] = {}) =>
  rtlRender(ui, { wrapper, ...opts });
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };
const caseRow = () => within(screen.getByTestId(T.row("case")));
const enterEdit = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(caseRow().getByRole("button", { name: "Edit Wholesale Case price, $13.91" }));

beforeEach(() => {
  mockError = null;
  mockSave.mockReset();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

const type = async (user: ReturnType<typeof userEvent.setup>, tier: number, text: string) => {
  const input = caseRow().getByTestId(T.input("case", tier));
  await user.clear(input);
  await user.type(input, text);
  return input;
};

describe("units v2 edit grid (S12a)", () => {
  it("V08: clicking a price enters edit mode focused on that cell's input, without scrolling", async () => {
    const focus = jest.spyOn(HTMLElement.prototype, "focus");
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    const input = caseRow().getByTestId(T.input("case", 2)) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("13.91");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  it("M1: the Edit button hands focus to the first price input, and Cancel gives it back", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await user.click(screen.getByTestId(T.btnEdit));
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute("data-testid")).toMatch(/^units-v2-input-/);
    await user.click(screen.getByTestId(T.ebCancel));
    expect(document.activeElement).toBe(screen.getByTestId(T.btnEdit));
  });

  it("M2: Change prices renders only when an opener is passed; the pill replaces Edit", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ProductPricingV2 product={product} />);
    expect(screen.queryByTestId(T.btnChange)).toBeNull();
    unmount();
    const onOpen = jest.fn();
    render(
      <PriceDraftProvider productId="p1">
        <EditablePricesGrid product={product} onOpenChangePrices={onOpen} />
      </PriceDraftProvider>,
    );
    await user.click(screen.getByTestId(T.btnChange));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId(T.btnEdit));
    expect(screen.getByTestId(T.editingPill)).toBeTruthy();
    expect(screen.queryByTestId(T.btnEdit)).toBeNull();
  });

  it("V04: Ctrl+S saves once with the revision and state, stops the browser save, ignores repeats", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    expect(fireEvent.keyDown(document, { key: "s", ctrlKey: true })).toBe(true);
    expect(mockSave).not.toHaveBeenCalled();
    await enterEdit(user);
    const input = await type(user, 2, "14.5");
    expect(fireEvent.keyDown(input, { key: "s", ctrlKey: true, repeat: true })).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(input, { key: "s", metaKey: true })).toBe(false);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual({
      expectedRevision: 7,
      expectedPriceState: "ps-1",
      patches: [{ ref: "case", tier: 2, to: 14.5 }],
      keeps: [],
      customerMoves: [],
    });
  });

  it("V04 + M5: the skip link is the first thing in main and jumps to Save", async () => {
    const main = document.body.appendChild(document.createElement("main"));
    main.id = "main-content";
    main.appendChild(document.createElement("button")).textContent = "page";
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />, {
      container: main.appendChild(document.createElement("div")),
    });
    expect(screen.queryByRole("link", { name: "Skip to Save" })).toBeNull();
    await enterEdit(user);
    const link = screen.getByRole("link", { name: "Skip to Save" });
    expect(main.querySelector("a")).toBe(link);
    await user.click(link);
    expect(document.activeElement).toBe(screen.getByTestId(T.ebSave));
    expect(screen.getByTestId(T.ebHint).textContent).toMatch(/(Ctrl|⌘)\+?S saves/);
    main.remove();
  });

  it("V14: exactly one save bar, Cancel then Save, in the DOM", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    expect(screen.getAllByRole("region", { name: "Unsaved changes" })).toHaveLength(1);
    expect(screen.getAllByTestId(T.editbar)).toHaveLength(1);
    const names = within(screen.getByTestId(T.editbar))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["Cancel", "Save"]);
  });

  it("Cancel on a changed draft asks first; Keep editing keeps it, Discard drops it", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await type(user, 2, "14.5");
    await user.click(screen.getByTestId(T.ebCancel));
    expect(screen.getByTestId(T.ebText).textContent).toContain("Discard your unsaved changes?");
    await user.click(screen.getByTestId(T.ebKeep));
    expect((caseRow().getByTestId(T.input("case", 2)) as HTMLInputElement).value).toBe("14.5");
    await user.click(screen.getByTestId(T.ebCancel));
    await user.click(screen.getByTestId(T.ebDiscard));
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.queryByTestId(T.editbar)).toBeNull();
    expect(
      caseRow().getByRole("button", { name: "Edit Wholesale Case price, $13.91" }),
    ).toBeTruthy();
  });

  it("V06: an order-unit switch is a draft with an inline review; Save is the one commit", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await user.selectOptions(screen.getByTestId(T.orderUnit), "case");
    expect(mockSave).not.toHaveBeenCalled();
    const review = screen.getByTestId(T.switchReview);
    expect(review.textContent).toContain("Orders now use the Case.");
    expect(review.textContent).toMatch(/Case Retail is now set at \$/);
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
    for (const b of within(review).queryAllByRole("button", { name: /^Keep / })) {
      expect(b.getAttribute("aria-label")).toMatch(/^Keep .+ at \$/);
    }
    await user.click(screen.getByTestId(T.ebSave));
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][0]).toEqual(expect.objectContaining({ orderUnit: "case" }));
  });

  it("V06: Undo switch removes the draft switch", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await user.selectOptions(screen.getByTestId(T.orderUnit), "case");
    await user.click(screen.getByTestId(T.switchUndo));
    expect(screen.queryByTestId(T.switchReview)).toBeNull();
    expect((screen.getByTestId(T.orderUnit) as HTMLSelectElement).value).toBe("piece");
  });

  it("a refused price (zero) marks its own input, names the cause and blocks Save", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    const input = await type(user, 2, "0");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const msg = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(msg?.textContent).toMatch(/above \$0\.00/);
    expect(screen.getByTestId(T.ebProblems).textContent).toContain("Wholesale Case");
    expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByTestId(T.ebSave));
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("a no-op edit (the served price retyped) is not a change", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    await type(user, 2, "13.910");
    expect(screen.getByTestId(T.ebText).textContent).toContain("Nothing changed yet");
    expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    ["LADDER_REVISION_STALE", {}, "Prices changed since you opened this; review and save again"],
    ["PRICE_EDIT_INVALID", { problems: ["Case needs a price"] }, "Case needs a price"],
    ["PRICING_RULES_NOT_READY", {}, "Changing the order unit is not available yet"],
  ])(
    "M4: a failed save (%s) says why in an alert and keeps the draft",
    async (code, extra, text) => {
      mockError = { response: { data: { code, ...extra } } };
      const user = userEvent.setup();
      render(<ProductPricingV2 product={product} />);
      await enterEdit(user);
      await type(user, 2, "14.5");
      expect(screen.getByRole("alert").textContent).toContain(text);
      expect((caseRow().getByTestId(T.input("case", 2)) as HTMLInputElement).value).toBe("14.5");
    },
  );

  it("an edited cell hands its plan to the also-update slot only", async () => {
    const user = userEvent.setup();
    render(<ProductPricingV2 product={product} />);
    await enterEdit(user);
    expect(screen.queryByTestId(PLAN_TESTIDS.cellPlan)).toBeNull();
    await type(user, 2, "14.5");
    expect(screen.getByTestId(PLAN_TESTIDS.cellPlan)).toBeTruthy();
  });

  it("K5 seam: onSaved/onEdit fire, and loadUndoPreview refetches and returns display strings", async () => {
    const onSaved = jest.fn();
    const onEdit = jest.fn();
    let draft!: PriceDraft;
    const Probe = () => {
      draft = usePriceDraft();
      return null;
    };
    const fresh = {
      ...grid,
      revision: 8,
      priceState: "ps-2",
      rows: grid.rows.map((r) =>
        r.ref === "case" ? { ...r, cells: cells([0, 14.5, 12.5, 11, 10], ["set", "set"]) } : r,
      ),
    };
    mockFresh = fresh;
    mockSave.mockImplementation((_p, o) =>
      o.onSuccess({
        auditId: "a1",
        revision: 8,
        undo: { patches: [{ ref: "case", tier: 2, to: 13.91 }], customerMoves: [] },
        grid: fresh,
      }),
    );
    const user = userEvent.setup();
    render(
      <PriceDraftProvider productId="p1" onSaved={onSaved} onEdit={onEdit}>
        <Probe />
        <EditablePricesGrid product={product} />
        <PriceEditBar />
      </PriceDraftProvider>,
    );
    await enterEdit(user);
    expect(onEdit).toHaveBeenCalled();
    await type(user, 2, "14.5");
    await user.click(screen.getByTestId(T.ebSave));
    expect(onSaved).toHaveBeenCalledWith({ auditId: "a1", revision: 8, undo: expect.anything() });
    expect(draft.lastSave?.auditId).toBe("a1");
    const preview = await draft.loadUndoPreview();
    expect(preview.revision).toBe(8);
    expect(preview.priceState).toBe("ps-2");
    expect(preview.rows).toContainEqual({
      ref: "case|2",
      label: "Wholesale Case",
      current: "$14.50",
      restoreTo: "$13.91",
    });
  });

  it("the grid shows the draft rows: Auto placeholders follow the preview", () => {
    const rows = grid.rows.map((r) =>
      r.ref === "box" ? { ...r, cells: cells([30, 22, 21, 20, 19]) } : r,
    );
    const edit: GridEditApi = {
      editing: true,
      begin: jest.fn(),
      text: (_r, _t, o) => o,
      setText: jest.fn(),
      changed: () => false,
      problem: () => null,
      addUnitProblem: () => null,
      rows,
      focus: null,
      focused: jest.fn(),
    };
    render(<ProductPricesGrid product={product} edit={edit} />);
    expect(
      within(screen.getByTestId(T.row("box")))
        .getByTestId(T.input("box", 1))
        .getAttribute("placeholder"),
    ).toBe("$30.00");
  });

  it("the grid without an edit api is today's read-only grid", () => {
    render(<ProductPricesGrid product={product} />);
    expect(
      screen.getByTestId(T.grid).querySelectorAll("input, button, select, textarea"),
    ).toHaveLength(0);
    expect(caseRow().getByTestId(T.cell("case", 2)).getAttribute("aria-label")).toBe(
      "Wholesale Case price, $13.91",
    );
  });

  it("no money math in the edit folder or the grid/shell: no rounding, toFixed, parseFloat or Number(..) arithmetic", () => {
    const here = [
      path.join(__dirname, "../../ProductPricesGrid.tsx"),
      path.join(__dirname, "../../ProductPricingV2.tsx"),
    ];
    for (const f of fs.readdirSync(__dirname)) {
      if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) here.push(path.join(__dirname, f));
    }
    for (const f of here) {
      expect(fs.readFileSync(f, "utf8")).not.toMatch(
        /Math\.(round|floor|ceil)|toFixed|parseFloat|Number\([^)]*\)\s*[*/+-]\s/,
      );
    }
  });
});
