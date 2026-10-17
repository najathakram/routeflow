import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { priceGridKey } from "@/lib/api/usePriceGrid";
import { act } from "react";
import type { CustomerMoveOffer } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { UNITS_V2_CONFIRM_TESTIDS as C } from "../confirm/confirm-testids";
import { emptyPlan } from "../change-prices/plan.test-utils";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceEditBar } from "./PriceEditBar";
import { PLAN_TESTIDS } from "../change-prices/plan-testids";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";

// K8 integration seams: K3's draft + K4's Change prices + K5's status line, mounted the way the page mounts them.

let mockGrid: {
  data?: ProductPriceGridDto;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
};
// One client per test so a test can spy on what the draft invalidates.
let mockQc = new QueryClient();
let mockError: unknown = null;
const mockSave = jest.fn();
const mockSaveReset = jest.fn();
// What the next `save.mutate` leaves in `save.error` (react-query clears it while a save runs, then sets the new one).
let mockSaveOutcome: unknown = null;
const mockUndo = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  // Stateful like the real mutation: `mutate` and `reset` replace `error` (until then it is `mockError`), so a test
  // sees what the page does after them.
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
      reset: () => {
        mockSaveReset();
        setAfter({ error: null });
      },
      isPending: false,
      error: after ? after.error : mockError,
    };
  },
  useUndoPrices: () => ({
    mutate: jest.fn(),
    mutateAsync: mockUndo,
    isPending: false,
    error: null,
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
let mockCustomers: unknown[] = [];
const mockCustomerFetch = jest.fn();
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: (_id: string, enabled: boolean) => {
    mockCustomerFetch(enabled);
    return { data: { customers: mockCustomers } };
  },
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
      factor: 960,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};
const saved: ProductPriceGridDto = { ...grid, revision: 8, priceState: "ps-2" };
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

let draft!: PriceDraft;
const Probe = () => {
  draft = usePriceDraft();
  return null;
};
const render = () =>
  rtlRender(
    <QueryClientProvider client={mockQc}>
      <ProductPricingV2 product={product} />
    </QueryClientProvider>,
  );
const edit = async (user: ReturnType<typeof userEvent.setup>, text = "14.5") => {
  await user.click(screen.getByTestId(T.btnEdit));
  const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
  await user.clear(input);
  await user.type(input, text);
};

beforeEach(() => {
  mockError = null;
  mockCustomers = [];
  mockCustomerFetch.mockReset();
  mockSave.mockReset();
  mockSaveReset.mockReset();
  mockSaveOutcome = null;
  mockUndo.mockReset();
  mockQc = new QueryClient();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("K8 seams", () => {
  it("one Undo: Saved shows K5's line only, and an Undo keeps 'Save undone.' with no Undo left", async () => {
    mockSave.mockImplementation((_req, o) => {
      mockGrid = { data: saved, isLoading: false, isError: false };
      o.onSuccess({
        auditId: "a1",
        revision: 8,
        undo: { patches: [{ ref: "case", tier: 2, to: 13.91 }], customerMoves: [] },
        grid: saved,
      });
    });
    mockUndo.mockResolvedValue({});
    const user = userEvent.setup();
    render();
    await edit(user);
    await user.click(screen.getByTestId(T.ebSave));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    await user.click(screen.getByTestId(C.saveUndo));
    expect(mockUndo).toHaveBeenCalledWith({
      auditId: "a1",
      expectedRevision: 8,
      expectedPriceState: "ps-2",
    });
    expect(await screen.findByText("Save undone.")).toBeTruthy();
    expect(screen.queryByTestId(C.saveUndo)).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a stale save shows K5's notice (one alert) with Reload prices", async () => {
    mockError = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };
    const user = userEvent.setup();
    render();
    await edit(user);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
  });

  it("K4 seam: Apply opens edit mode, leaves the customer offer at index 0, Keeps toggle on and off", async () => {
    const customerMoves = [{ customerId: "c1", ref: "case", tier: 2 as const, from: 13.5, to: 14 }];
    const plan = emptyPlan({
      patches: [{ ref: "case", tier: 2, to: 14 }],
      offers: [
        {
          kind: "customer",
          ticked: false,
          title: "Also raise prices set for 1 customer",
          moves: customerMoves.map((m) => ({ ...m, against: false })),
        },
      ],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
    });
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    expect(draft.editing).toBe(false);
    act(() => draft.applyPlan(plan));
    act(() => draft.setOfferTicked(0, true));
    expect(draft.editing).toBe(true);
    expect(draft.plan?.cell).toBeNull();
    expect(draft.plan?.ticked).toEqual([true]);
    expect(draft.canSave).toBe(true);
    expect(draft.toRequest()).toMatchObject({
      expectedRevision: 7,
      expectedPriceState: "ps-1",
      patches: [{ ref: "case", tier: 2, to: 14 }],
      customerMoves,
    });
    const keep = { customerId: "c2", ref: "case", tier: 1, from: null, to: 9 };
    act(() => draft.keepCustomer(keep));
    act(() => draft.keepCustomer(keep));
    expect(draft.plan?.customerKeeps).toEqual([keep]);
    expect(draft.toRequest()?.customerMoves).toEqual([...customerMoves, keep]);
    act(() => draft.keepCustomer(keep, false));
    expect(draft.plan?.customerKeeps).toEqual([]);
  });

  it("an edited cell exposes the fields K4's panel reads (cell, ticked, keeps)", async () => {
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    await edit(user);
    expect(draft.plan?.cell).toEqual({ ref: "case", tier: 2 });
    expect(draft.plan?.ticked.some(Boolean)).toBe(false);
    expect(draft.plan?.keeps).toEqual([]);
  });

  describe("ticked offers are baked into the draft (lead ruling)", () => {
    const mount = () =>
      rtlRender(
        <QueryClientProvider client={new QueryClient()}>
          <PriceDraftProvider productId="p1">
            <Probe />
            <EditablePricesGrid product={product} />
            <PriceEditBar />
          </PriceDraftProvider>
        </QueryClientProvider>,
      );
    const customerOffer = (moves: CustomerMoveOffer["moves"]) =>
      ({
        kind: "customer",
        ticked: false,
        title: "Also raise prices set for 1 customer",
        moves,
      }) as const;
    const move = { customerId: "c1", ref: "case", tier: 2 as const, from: 13.5, to: 14 };

    it("a ticked Change prices customer offer survives editing another cell; untick removes it", () => {
      mount();
      const plan = emptyPlan({
        patches: [{ ref: "case", tier: 2, to: 14 }],
        offers: [customerOffer([{ ...move, against: true, cause: "shape" }])],
        changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
      });
      act(() => draft.applyPlan(plan));
      act(() => draft.setOfferTicked(0, true));
      act(() => void draft.editCell("piece", 2, "0.8"));
      expect(draft.plan?.cell).toEqual({ ref: "piece", tier: 2 });
      expect(draft.toRequest()?.customerMoves).toEqual([move]);
      expect(draft.toRequest()?.patches).toEqual(
        expect.arrayContaining([
          { ref: "case", tier: 2, to: 14 },
          { ref: "piece", tier: 2, to: 0.8 },
        ]),
      );
      // untick, on a fresh plan: removes exactly what the tick added
      act(() => draft.discard());
      act(() => draft.applyPlan(plan));
      act(() => draft.setOfferTicked(0, true));
      expect(draft.toRequest()?.customerMoves).toEqual([move]);
      act(() => draft.setOfferTicked(0, false));
      expect(draft.toRequest()?.customerMoves).toEqual([]);
      expect(draft.plan?.ticked).toEqual([false]);
    });

    it("a ticked tier offer survives editing another cell; untick removes its patches", () => {
      mount();
      act(() => void draft.editCell("case", 4, "5"));
      const offer = draft.plan?.plan.offers[0];
      expect(offer?.kind).toBe("tier");
      const tierPatches = offer?.kind === "tier" ? offer.patches : [];
      expect(tierPatches.length).toBeGreaterThan(0);
      act(() => draft.setOfferTicked(0, true));
      expect(draft.plan?.ticked).toEqual([true]);
      expect(draft.toRequest()?.patches).toEqual(expect.arrayContaining(tierPatches));
      act(() => void draft.editCell("piece", 2, "0.8"));
      expect(draft.plan?.cell).toEqual({ ref: "piece", tier: 2 });
      expect(draft.toRequest()?.patches).toEqual(expect.arrayContaining(tierPatches));
      expect(draft.notice).toBeNull();
      // untick on a fresh draft
      act(() => draft.discard());
      act(() => void draft.editCell("case", 4, "5"));
      act(() => draft.setOfferTicked(0, true));
      act(() => draft.setOfferTicked(0, false));
      expect(draft.toRequest()?.patches).toEqual([{ ref: "case", tier: 4, to: 5 }]);
    });

    it("re-typing the same cell clears its ticked offers with a visible notice, never silently", () => {
      mount();
      act(() => draft.startEditing());
      act(() => void draft.editCell("case", 4, "5"));
      act(() => draft.setOfferTicked(0, true));
      act(() => void draft.editCell("case", 4, "6"));
      expect(draft.plan?.ticked).toEqual([false]);
      expect(draft.notice).toMatch(/Your earlier choice .* was cleared/);
      expect(screen.getByTestId(T.ebNotice).textContent).toMatch(/was cleared/);
    });
  });

  describe("MUST-2 and review nits", () => {
    const mount = () =>
      rtlRender(
        <QueryClientProvider client={new QueryClient()}>
          <PriceDraftProvider productId="p1">
            <Probe />
            <EditablePricesGrid product={product} />
            <PriceEditBar />
          </PriceDraftProvider>
        </QueryClientProvider>,
      );
    const mv = { customerId: "c1", ref: "case", tier: 2 as const, from: 13.5, to: 14 };
    const offer = (to: number, customerId = "c1"): CustomerMoveOffer => ({
      kind: "customer",
      ticked: false,
      title: "Also raise prices set for 1 customer",
      moves: [{ ...mv, customerId, to, against: false }],
    });
    const apply = (to: number) => {
      act(() =>
        draft.applyPlan(
          emptyPlan({ patches: [{ ref: "case", tier: 2, to }], offers: [offer(to)] }),
        ),
      );
      act(() => draft.setOfferTicked(0, true));
    };

    it("two Applies that each tick the customer offer move the same customer cell: Save is blocked", () => {
      mount();
      apply(14);
      expect(draft.conflicts).toEqual([]);
      expect(draft.canSave).toBe(true);
      apply(15);
      expect(draft.conflicts).toEqual([
        "These customer prices are already changing in this draft. Save first.",
      ]);
      expect(draft.canSave).toBe(false);
      expect(draft.toRequest()).toBeNull();
      expect(screen.getByTestId(T.ebConflicts).textContent).toContain("Save first.");
      expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).toBe("true");
      // the save bar names what is already baked in
      expect(screen.getByTestId(T.ebBaked).textContent).toContain(
        "Includes: Also raise prices set for 1 customer",
      );
    });

    it("different customer cells do not conflict", () => {
      mount();
      apply(14);
      act(() =>
        draft.applyPlan(
          emptyPlan({
            patches: [{ ref: "case", tier: 3, to: 12 }],
            offers: [offer(9, "c2")],
          }),
        ),
      );
      act(() => draft.setOfferTicked(0, true));
      expect(draft.conflicts).toEqual([]);
      expect(draft.toRequest()?.customerMoves).toHaveLength(2);
    });

    it("Reset all to Auto drops ticked customer moves with a visible notice", () => {
      mount();
      apply(14);
      expect(draft.toRequest()?.customerMoves).toHaveLength(1);
      act(() => draft.resetAllToAuto());
      expect(draft.toRequest()?.customerMoves ?? []).toEqual([]);
      expect(draft.notice).toMatch(/was cleared because you reset every price to Auto/);
    });

    const STALE = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };
    const moveGridOn = (rerender: (ui: React.ReactElement) => void) => {
      mockGrid = {
        data: { ...grid, revision: 9, priceState: "ps-9" },
        isLoading: false,
        isError: false,
      };
      rerender(
        <QueryClientProvider client={mockQc}>
          <ProductPricingV2 product={product} />
        </QueryClientProvider>,
      );
    };
    const caseInput = () =>
      (
        within(screen.getByTestId(T.row("case"))).getByTestId(
          T.input("case", 2),
        ) as HTMLInputElement
      ).value;

    it("the stale-write notice stays when the grid refetches onto a new revision", async () => {
      mockError = STALE;
      const user = userEvent.setup();
      const { rerender } = render();
      await edit(user);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
      moveGridOn(rerender);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
      expect(caseInput()).toBe("14.5");
    });

    it("Reload prices clears the stale-write notice, reloads the grid and keeps the draft; the next Save carries the fresh revision", async () => {
      mockError = STALE;
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      const { rerender } = render();
      await edit(user);
      moveGridOn(rerender);
      await user.click(screen.getByRole("button", { name: "Reload prices" }));
      expect(mockSaveReset).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
      expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
      expect(caseInput()).toBe("14.5");
      await user.click(screen.getByTestId(T.ebSave));
      expect(mockSave.mock.calls[0][0]).toMatchObject({
        expectedRevision: 9,
        expectedPriceState: "ps-9",
        patches: [{ ref: "case", tier: 2, to: 14.5 }],
      });
    });

    it("Discard after a stale save clears the notice and reloads the grid, so the next Edit starts clean", async () => {
      mockError = STALE;
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      render();
      await edit(user);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
      await user.click(screen.getByTestId(T.ebCancel));
      await user.click(screen.getByTestId(T.ebDiscard));
      expect(mockSaveReset).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
      await user.click(screen.getByTestId(T.btnEdit));
      expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("Discard with no save error neither resets the save nor reloads the grid", async () => {
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      render();
      await edit(user);
      await user.click(screen.getByTestId(T.ebCancel));
      await user.click(screen.getByTestId(T.ebDiscard));
      expect(mockSaveReset).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    it("Save stays off while the grid is refetching, so a draft is never saved against a revision about to change", async () => {
      const user = userEvent.setup();
      const { rerender } = render();
      await edit(user);
      expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).not.toBe("true");
      mockGrid = { ...mockGrid, isFetching: true };
      rerender(
        <QueryClientProvider client={mockQc}>
          <ProductPricingV2 product={product} />
        </QueryClientProvider>,
      );
      expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).toBe("true");
    });

    it("the next save attempt clears the stale-write notice; a second stale answer raises it again", async () => {
      mockError = STALE;
      const user = userEvent.setup();
      render();
      await edit(user);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
      const body = {
        expectedRevision: 7,
        expectedPriceState: "ps-1",
        patches: [{ ref: "case", tier: 2, to: 14.5 }],
      };
      await user.click(screen.getByTestId(T.ebSave));
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave.mock.calls[0][0]).toMatchObject(body);
      expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
      mockSaveOutcome = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };
      await user.click(screen.getByTestId(T.ebSave));
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave.mock.calls[1][0]).toMatchObject(body);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();
      expect(caseInput()).toBe("14.5");
    });
  });

  it("a plain cell edit plans with the product's customers: their changes show, fetched only while editing", async () => {
    mockCustomers = [{ customerId: "c1", name: "Northside", tier: 2, orderUnit: null, set: {} }];
    const user = userEvent.setup();
    render();
    expect(mockCustomerFetch.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
    await edit(user);
    expect(mockCustomerFetch).toHaveBeenCalledWith(true);
    const panel = screen.getByTestId(PLAN_TESTIDS.cellPlan);
    expect(within(panel).getByTestId(PLAN_TESTIDS.alsoChanges)).toBeTruthy();
    const rows = within(panel).getAllByTestId(PLAN_TESTIDS.customerRow);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].textContent).toContain("Northside");
  });

  it("a plain cell edit with customers offers their moves, unticked; ticking carries them in the save", async () => {
    mockCustomers = [
      { customerId: "c1", name: "Northside", tier: 2, orderUnit: "case", set: { piece: 0.5 } },
    ];
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
          <PriceEditBar />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    await edit(user);
    const title = "Also raise prices set for these customers, in step with their tier (1 price).";
    const box = screen.getByRole("checkbox", { name: new RegExp(title.slice(0, 40)) });
    expect(box).not.toBeChecked();
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByTestId(PLAN_TESTIDS.offerMove).getAttribute("data-against")).toBe("false");
    expect(draft.toRequest()?.customerMoves).toEqual([]);
    await user.click(box);
    expect(box).toBeChecked();
    expect(draft.toRequest()?.customerMoves).toEqual([
      { customerId: "c1", ref: "piece", tier: 2, from: 0.5, to: 0.52 },
    ]);
    await user.click(box);
    expect(draft.toRequest()?.customerMoves).toEqual([]);
  });

  it("a first price on the implicit base row shows the server's 'Add the Piece unit first' inline, with a pointer", async () => {
    const packRow = {
      ref: "pack",
      label: "Case",
      factor: 24,
      kind: "pack" as const,
      editable: true,
      code: null,
      cells: cells([12, 11, 10, 9, 8], ["set"]),
    };
    const baseRow = {
      ref: "base",
      label: "Piece",
      factor: 1,
      kind: "base" as const,
      editable: true,
      code: null,
      cells: cells([0, 0, 0, 0, 0]),
    };
    mockGrid = {
      data: { ...grid, anchor: "pack", rows: [packRow, baseRow] },
      isLoading: false,
      isError: false,
    };
    const field = document.body.appendChild(document.createElement("input"));
    field.id = "new-unit-name";
    const user = userEvent.setup();
    const qc = new QueryClient();
    const ui = () => (
      <QueryClientProvider client={qc}>
        <ProductPricingV2 product={product} />
      </QueryClientProvider>
    );
    const { rerender } = rtlRender(ui());
    await user.click(screen.getByTestId(T.btnEdit));
    const input = within(screen.getByTestId(T.row("base"))).getByTestId(T.input("base", 2));
    await user.type(input, "0.9");
    mockError = {
      response: { data: { code: "PRICE_EDIT_INVALID", problems: ["Add the Piece unit first"] } },
    };
    rerender(ui());
    const inRow = within(screen.getByTestId(T.row("base")));
    expect(inRow.getByText(/Add the Piece unit first/)).toBeTruthy();
    const describedBy = inRow.getByTestId(T.input("base", 2)).getAttribute("aria-describedby");
    expect(describedBy).toBe(T.problem("table", "base", 2));
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Add the Piece unit first",
    );
    await user.click(inRow.getByTestId(T.addUnitPointer));
    expect(document.activeElement).toBe(field);
    // typing something else is a different attempt: the old refusal no longer sticks to the cell
    await user.type(input, "1");
    expect(inRow.queryByTestId(T.addUnitPointer)).toBeNull();
    field.remove();
  });

  it("a base row the grid marks editable:false shows its reason and the add-unit pointer, with no input", async () => {
    const packRow = { ...grid.rows[0], ref: "pack", label: "Case", factor: 24 };
    const baseRow = {
      ref: "base",
      label: "Piece",
      factor: 1,
      kind: "base" as const,
      editable: false,
      notEditableReason: "Add the Piece unit first.",
      code: null,
      cells: cells([0, 0, 0, 0, 0]),
    };
    mockGrid = {
      data: { ...grid, anchor: "pack", rows: [packRow, baseRow] },
      isLoading: false,
      isError: false,
    };
    const field = document.body.appendChild(document.createElement("input"));
    field.id = "new-unit-name";
    const user = userEvent.setup();
    render();
    const row = within(screen.getByTestId(T.row("base")));
    expect(row.getByTestId(T.notEditable("base")).textContent).toContain(
      "Add the Piece unit first.",
    );
    expect(row.queryByRole("button", { name: /^Edit / })).toBeNull();
    await user.click(screen.getByTestId(T.btnEdit));
    expect(row.queryByTestId(T.input("base", 2))).toBeNull();
    await user.click(row.getByTestId(T.addUnitPointer));
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("conflictRow: customer name (or 'A customer'), tier-first unit label, money as shown", () => {
    mockCustomers = [{ customerId: "c1", name: "Northside", tier: 2, orderUnit: null, set: {} }];
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    const c = { customerId: "c1", ref: "case", tier: 2, expected: 13.5, current: 14 };
    expect(draft.conflictRow(c)).toEqual({
      ref: "c1|case|2",
      label: "Northside, Wholesale Case",
      current: "$14.00",
      restoreTo: "$13.50",
    });
    expect(draft.conflictRow({ ...c, customerId: "zz", current: null }).label).toMatch(
      /^A customer, Wholesale Case$/,
    );
    expect(draft.conflictRow({ ...c, current: null }).current).toBe("No set price");
  });

  it("a family-governed row is read-only with its reason; the other rows stay editable", async () => {
    const reason = "Its price is set on the family.";
    mockGrid = {
      data: {
        ...grid,
        rows: [{ ...grid.rows[0], editable: false, notEditableReason: reason }, grid.rows[1]],
      },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    render();
    const caseRow = within(screen.getByTestId(T.row("case")));
    expect(caseRow.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(caseRow.getByTestId(T.notEditable("case")).textContent).toBe(reason);
    expect(caseRow.getByText("$13.91")).toBeTruthy();
    const pieceRow = within(screen.getByTestId(T.row("piece")));
    expect(pieceRow.getAllByRole("button", { name: /^Edit / }).length).toBeGreaterThan(0);
    await user.click(screen.getByTestId(T.btnEdit));
    expect(caseRow.queryByTestId(T.input("case", 2))).toBeNull();
    expect(pieceRow.getByTestId(T.input("piece", 2))).toBeTruthy();
  });

  it("with every row family-governed there is nothing to edit: no Edit, no Change prices", () => {
    mockGrid = {
      data: {
        ...grid,
        rows: grid.rows.map((r) => ({
          ...r,
          editable: false as const,
          notEditableReason: "On the family.",
        })),
      },
      isLoading: false,
      isError: false,
    };
    render();
    expect(screen.queryByTestId(T.btnEdit)).toBeNull();
    expect(screen.queryByRole("button", { name: "Change prices" })).toBeNull();
  });

  it('SA-809: the 1-piece level is keyed "base" everywhere (test ids, conflict rows, customer move keys)', async () => {
    mockCustomers = [{ customerId: "c1", name: "Northside", tier: 2, orderUnit: "pack", set: {} }];
    const packRow = { ...grid.rows[0], ref: "pack", label: "Case", factor: 24 };
    const baseRow = {
      ...grid.rows[1],
      ref: "base",
      label: "Piece",
      factor: 1,
      kind: "base" as const,
    };
    mockGrid = {
      data: { ...grid, anchor: "pack", rows: [packRow, baseRow] },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId(T.row("base"))).toBeTruthy();
    expect(screen.getAllByTestId(T.cell("base", 2)).length).toBeGreaterThan(0);
    expect(
      draft.conflictRow({ customerId: "c1", ref: "base", tier: 2, expected: 0.9, current: 1 }),
    ).toEqual({
      ref: "c1|base|2",
      label: "Northside, Wholesale Piece",
      current: "$1.00",
      restoreTo: "$0.90",
    });
    await user.click(screen.getByTestId(T.btnEdit));
    await user.type(within(screen.getByTestId(T.row("base"))).getByTestId(T.input("base", 2)), "1");
    expect(draft.toRequest()?.patches.every((p) => p.ref === "base" || p.ref === "pack")).toBe(
      true,
    );
  });

  it("the product page mounts the customer price view exactly once", () => {
    render();
    expect(screen.getAllByTestId("units-v2-sec-customers")).toHaveLength(1);
  });

  it("one Change prices button, in the Edit row (before Edit), and none above the grid", async () => {
    render();
    const buttons = screen.getAllByRole("button", { name: "Change prices" });
    expect(buttons).toHaveLength(1);
    const row = buttons[0].parentElement as HTMLElement;
    expect(within(row).getByTestId(T.btnEdit)).toBeTruthy();
    expect(buttons[0].compareDocumentPosition(screen.getByTestId(T.btnEdit))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(buttons[0].compareDocumentPosition(screen.getByTestId(T.grid))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("Escape closes Change prices and returns focus to the one opener (V17)", async () => {
    const user = userEvent.setup();
    render();
    const opener = screen.getByRole("button", { name: "Change prices" });
    await user.click(opener);
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId(PLAN_TESTIDS.changePanel)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId(PLAN_TESTIDS.changePanel)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
