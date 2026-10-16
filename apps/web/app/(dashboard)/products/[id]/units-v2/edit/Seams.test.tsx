import * as React from "react";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { priceGridKey } from "@/lib/api/usePriceGrid";
import { productCustomerPricesKey } from "@/lib/api/useProductCustomerPrices";
import { act } from "react";
import { planPriceChange, type CustomerMoveOffer, type PriceChange } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { UNITS_V2_CONFIRM_TESTIDS as C } from "../confirm/confirm-testids";
import { customerChange, emptyPlan } from "../change-prices/plan.test-utils";
import { EMPTY_SELECTION, foldPlan, keepMove } from "../change-prices/selection";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceEditBar } from "./PriceEditBar";
import { PLAN_TESTIDS } from "../change-prices/plan-testids";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";
import { rulesFromGrid, viewFromGrid } from "./view-from-grid";

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
let mockCustomersFetching = false;
const mockCustomerFetch = jest.fn();
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: (_id: string, enabled: boolean) => {
    mockCustomerFetch(enabled);
    return { data: { customers: mockCustomers }, isFetching: mockCustomersFetching };
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

/** The customers the hand-built offers below move: each holds the case price 13.5 the moves start from. */
const holders = (...ids: string[]) =>
  ids.map((customerId) => ({
    customerId,
    name: `Customer ${customerId}`,
    tier: 2,
    orderUnit: null,
    set: { case: 13.5 },
  }));

let draft!: PriceDraft;
let probeRenders = 0;
const Probe = () => {
  draft = usePriceDraft();
  probeRenders++;
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
  mockCustomersFetching = false;
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
    mockCustomers = holders("c1");
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
      // c2 has no price of its own: the plan shows its derived Case price (9 now), which a Keep can pin
      customerChanges: [customerChange(2, { ref: "case", tier: 1, from: 9, to: 9.5 })],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
    });
    mockCustomers = [...holders("c1"), { ...holders("c2")[0], tier: 1, set: {} }];
    rtlRender(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <Probe />
          <EditablePricesGrid product={product} />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    expect(draft.editing).toBe(false);
    act(() => draft.applyPlan(plan, () => plan));
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
    beforeEach(() => {
      mockCustomers = holders("c1");
    });

    it("a ticked Change prices customer offer survives editing another cell; untick removes it", () => {
      mount();
      const plan = emptyPlan({
        patches: [{ ref: "case", tier: 2, to: 14 }],
        offers: [customerOffer([{ ...move, against: true, cause: "shape" }])],
        changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
      });
      act(() => draft.applyPlan(plan, () => plan));
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
      act(() => draft.applyPlan(plan, () => plan));
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
    beforeEach(() => {
      mockCustomers = holders("c1", "c2");
    });
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
      const plan = emptyPlan({ patches: [{ ref: "case", tier: 2, to }], offers: [offer(to)] });
      act(() => draft.applyPlan(plan, () => plan));
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
      const other = emptyPlan({
        patches: [{ ref: "case", tier: 3, to: 12 }],
        offers: [offer(9, "c2")],
      });
      act(() => draft.applyPlan(other, () => other));
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

// K3b: a ticked customer offer froze its moves when it was ticked. Another user can move a customer's price, add a
// customer or change an order unit; the offer on screen must then be the fresh one, unticked, with a notice.
describe("K3b: customer offers go stale", () => {
  const NOTICE =
    "Your earlier choice to update customer prices was cleared because those customers' prices changed. Tick it again to use the new prices.";
  const REFUSED =
    "Those customers' prices changed, so this choice can't be used. Review the new prices.";
  const KEEP_NOTICE =
    "Your earlier choice to keep a customer price was cleared because that customer's prices changed.";
  const c1 = {
    customerId: "c1",
    name: "Northside",
    tier: 2,
    orderUnit: "case",
    set: { piece: 0.5 },
  };
  const c2 = {
    customerId: "c2",
    name: "Southside",
    tier: 2,
    orderUnit: "case",
    set: { piece: 0.8 },
  };
  // Two typed prices: the order unit decides which of them follow a Case edit.
  const twoPrices = { ...c1, set: { piece: 0.5, case: 13 } };
  const copy = (cs: unknown[]) => cs.map((c) => ({ ...(c as object), set: { ...(c as any).set } }));
  const STALE = { response: { status: 409, data: { code: "LADDER_REVISION_STALE" } } };

  const tree = () => (
    <QueryClientProvider client={mockQc}>
      <PriceDraftProvider productId="p1">
        <Probe />
        <EditablePricesGrid product={product} />
        <PriceEditBar />
      </PriceDraftProvider>
    </QueryClientProvider>
  );
  // `again` re-renders with a fresh element, so the provider runs again on whatever `mockCustomers` now is.
  const mount = () => {
    const r = rtlRender(tree());
    return { ...r, again: () => r.rerender(tree()) };
  };
  const customerIdx = () => draft.plan!.plan.offers.findIndex((o) => o.kind === "customer");
  const customerTicked = () => draft.plan!.ticked[customerIdx()];
  const customerMoves = () => draft.toRequest()?.customerMoves;
  const editAndTick = () => {
    act(() => draft.startEditing());
    act(() => void draft.editCell("case", 2, "14.5"));
    act(() => draft.setOfferTicked(customerIdx(), true));
  };

  it.each([
    ["a customer is added", [c1], [c1, c2]],
    ["a customer's price (the move's from) changes", [c1], [{ ...c1, set: { piece: 0.6 } }]],
    ["a customer's tier moves", [c1], [{ ...c1, tier: 3 }]],
    ["a customer's order unit moves", [twoPrices], [{ ...twoPrices, orderUnit: "piece" }]],
  ])(
    "M1: %s, so the ticked offer is unticked with a notice, never re-ticked",
    (_n, before, after) => {
      mockCustomers = before;
      const { again } = mount();
      editAndTick();
      expect(customerTicked()).toBe(true);
      expect(customerMoves()!.length).toBeGreaterThan(0);

      mockCustomers = after;
      again();
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(NOTICE);
      expect(screen.getByTestId(T.ebNotice).textContent).toBe(NOTICE);
      // the open plan is the fresh one, unticked (a tier move or order-unit move may leave nothing to offer)
      if (customerIdx() >= 0) expect(customerTicked()).toBe(false);

      // the customers coming back to what was ticked does not tick it again
      mockCustomers = before;
      again();
      expect(customerMoves()).toEqual([]);
      if (customerIdx() >= 0) expect(customerTicked()).toBe(false);
    },
  );

  it("M1: the open plan shows the new from and to once the price moved", () => {
    mockCustomers = [c1];
    const { again } = mount();
    editAndTick();
    mockCustomers = [{ ...c1, set: { piece: 0.6 } }];
    again();
    const offer = draft.plan!.plan.offers[customerIdx()];
    expect(offer.kind === "customer" && offer.moves).toEqual([
      expect.objectContaining({ customerId: "c1", ref: "piece", tier: 2, from: 0.6, to: 0.63 }),
    ]);
    act(() => draft.setOfferTicked(customerIdx(), true));
    expect(customerMoves()).toEqual([
      { customerId: "c1", ref: "piece", tier: 2, from: 0.6, to: 0.63 },
    ]);
  });

  it("M1: customers that arrive unchanged (same reference, or equal copies) leave the offer ticked, no notice", () => {
    mockCustomers = [c1];
    const { again } = mount();
    editAndTick();
    again();
    expect(customerTicked()).toBe(true);
    mockCustomers = copy(mockCustomers);
    again();
    expect(customerTicked()).toBe(true);
    expect(customerMoves()).toHaveLength(1);
    expect(draft.notice).toBeNull();
  });

  describe("an applied Change prices plan", () => {
    const change: PriceChange = {
      unit: "case",
      direction: "raise",
      mode: "percent",
      value: 10,
      also: true,
    };
    const holder = { id: "c1", name: "Northside", tier: 2, orderUnit: null };
    const cust = (price: number) => ({ customerId: holder.id, ...holder, set: { case: price } });
    const plan = (cs: readonly any[]) =>
      planPriceChange(viewFromGrid(grid), change, rulesFromGrid(grid), undefined, {
        customers: cs,
      });
    // What ChangePricesPanel.apply does: fold the (unticked) tier offers, hand over the re-planner.
    const applied = (cs: any[]) => foldPlan(plan(cs), EMPTY_SELECTION).plan;
    const apply = (cs: any[]) => act(() => draft.applyPlan(applied(cs), plan));
    const move = (from: number, to: number) => ({
      customerId: "c1",
      ref: "case",
      tier: 2,
      from,
      to,
    });

    it("M2: after another user moves the price, Save 409 and Reload, the offer is fresh and unticked; ticking it saves the fresh from", async () => {
      mockCustomers = [cust(13.5)];
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      const { again } = mount();
      const offered = plan([cust(13.5)]).offers[0];
      expect(offered.kind === "customer" && offered.moves[0]).toMatchObject({ from: 13.5 });
      apply([cust(13.5)]);
      act(() => draft.setOfferTicked(0, true));
      const first = customerMoves()!;
      expect(first).toEqual([expect.objectContaining({ customerId: "c1", from: 13.5 })]);

      mockSaveOutcome = STALE;
      await user.click(screen.getByTestId(T.ebSave));
      expect(mockSave.mock.calls[0][0].customerMoves).toEqual(first);
      expect(screen.getByRole("button", { name: "Reload prices" })).toBeTruthy();

      // another user changed the customer's price to 14; Reload refetches both queries
      mockCustomers = [cust(14)];
      mockSaveOutcome = null;
      await user.click(screen.getByRole("button", { name: "Reload prices" }));
      expect(spy).toHaveBeenCalledWith({ queryKey: productCustomerPricesKey("p1") });
      again();
      expect(draft.plan!.ticked).toEqual([false]);
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(NOTICE);
      const fresh = plan([cust(14)]).offers[0];
      expect(draft.plan!.plan.offers[0]).toMatchObject({
        kind: "customer",
        moves: [
          expect.objectContaining({
            from: 14,
            to: fresh.kind === "customer" ? fresh.moves[0].to : 0,
          }),
        ],
      });

      // tick it: Save carries the fresh from and goes through
      act(() => draft.setOfferTicked(0, true));
      const to = fresh.kind === "customer" ? fresh.moves[0].to : 0;
      expect(customerMoves()).toEqual([move(14, to)]);
      await user.click(screen.getByTestId(T.ebSave));
      expect(mockSave.mock.calls[1][0].customerMoves).toEqual([move(14, to)]);
      expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
    });

    it("M2: a second Reload that returns identical data changes nothing and does not loop", async () => {
      mockCustomers = [cust(14)];
      const user = userEvent.setup();
      const { again } = mount();
      apply([cust(14)]);
      act(() => draft.setOfferTicked(0, true));
      const moves = customerMoves();
      mockSaveOutcome = STALE;
      await user.click(screen.getByTestId(T.ebSave));
      mockSaveOutcome = null;
      for (const same of [mockCustomers, copy(mockCustomers)]) {
        mockCustomers = same;
        await user.click(screen.getByRole("button", { name: "Reload prices" }));
        const before = probeRenders;
        again();
        expect(draft.plan!.ticked).toEqual([true]);
        expect(customerMoves()).toEqual(moves);
        expect(draft.notice).toBeNull();
        expect(probeRenders - before).toBeLessThan(3);
        mockSaveOutcome = STALE;
        await user.click(screen.getByTestId(T.ebSave));
        mockSaveOutcome = null;
      }
    });

    it("M2: a tick whose from no longer matches the fresh customer price is refused, with its own notice", () => {
      // Apply from a plan worked out when the customer was at 13.5; the draft already holds the customer at 14
      mockCustomers = [cust(14)];
      mount();
      act(() => {
        draft.applyPlan(applied([cust(13.5)]), plan);
        draft.setOfferTicked(0, true);
      });
      expect(draft.plan!.ticked).toEqual([false]);
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(REFUSED);
      expect(draft.notice).not.toMatch(/was cleared/);
      // the open plan is the fresh one, so ticking it now is fine
      act(() => draft.setOfferTicked(0, true));
      expect(customerMoves()).toEqual([expect.objectContaining({ customerId: "c1", from: 14 })]);
    });

    it("M2: the same tick on a customer price that did not move is kept", () => {
      mockCustomers = [cust(13.5)];
      mount();
      act(() => {
        draft.applyPlan(applied([cust(13.5)]), plan);
        draft.setOfferTicked(0, true);
      });
      expect(draft.plan!.ticked).toEqual([true]);
      expect(draft.notice).toBeNull();
    });
  });

  describe("M3: customer Keeps are re-checked against what the panel shows", () => {
    // c1 pays a set Piece price, so its Case price is derived from it: a Keep on that Case row pins the derived price.
    const base = {
      customerId: "c1",
      name: "Northside",
      tier: 2,
      orderUnit: "piece",
      set: { piece: 0.5 },
    };
    const caseRow = () =>
      draft.plan!.plan.customerChanges.find((c) => c.customerId === "c1" && c.ref === "case")!;
    const start = () => {
      mockCustomers = [base];
      const view = mount();
      act(() => draft.startEditing());
      act(() => void draft.editCell("case", 2, "14.5"));
      const keep = keepMove(caseRow());
      act(() => draft.keepCustomer(keep));
      return { ...view, keep };
    };

    it("a Keep on a derived price the panel still shows stays, and the panel shows it kept", () => {
      const { again, keep } = start();
      again();
      expect(draft.plan).not.toBeNull();
      expect(draft.plan!.customerKeeps).toEqual([keep]);
      expect(customerMoves()).toEqual([keep]);
      expect(draft.notice).toBeNull();
    });

    it("scenario A: another user changes the Piece price, so the derived Case price the Keep pinned moved: the Keep is dropped", () => {
      const { again, keep } = start();
      mockCustomers = [{ ...base, set: { piece: 0.6 } }];
      again();
      // the panel's Case row now starts from a different price; a Keep must not write the old one as a set price
      expect(caseRow().from).not.toBe(keep.to);
      expect(draft.plan!.customerKeeps).toEqual([]);
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(KEEP_NOTICE);
    });

    it.each([
      ["the customer is deleted", () => []],
      ["the customer changes tier", () => [{ ...base, tier: 3 }]],
    ])(
      "scenario B: %s, so the row leaves the panel and the Keep leaves the request",
      (_n, after) => {
        const { again } = start();
        mockCustomers = after();
        again();
        expect(draft.plan!.customerKeeps).toEqual([]);
        expect(customerMoves()).toEqual([]);
        expect(draft.notice).toBe(KEEP_NOTICE);
        expect(draft.canSave).toBe(true);
      },
    );

    it("a customer who now has a price of their own on the unit loses the Keep", () => {
      const { again } = start();
      mockCustomers = [{ ...base, set: { piece: 0.5, case: 14 } }];
      again();
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(KEEP_NOTICE);
    });

    it("the customer coming back does not bring the Keep back", () => {
      const { again } = start();
      mockCustomers = [];
      again();
      mockCustomers = [base];
      again();
      expect(customerMoves()).toEqual([]);
    });

    it("an offer and a Keep on the same customer both go when its order unit changes, and both are said", () => {
      // an offer (its Piece price follows the Case) and a Keep (its derived Case price) on one customer
      mockCustomers = [{ ...base, orderUnit: "case" }];
      const { again } = mount();
      act(() => draft.startEditing());
      act(() => void draft.editCell("case", 2, "14.5"));
      act(() => draft.setOfferTicked(customerIdx(), true));
      act(() => draft.keepCustomer(keepMove(caseRow())));
      expect(customerMoves()).toHaveLength(2);
      mockCustomers = [base];
      again();
      expect(customerMoves()).toEqual([]);
      expect(draft.notice).toBe(`${NOTICE} ${KEEP_NOTICE}`);
    });
  });

  it("MUST-2: a stale customer offer found at render adds to the notice an edit just raised, never replaces it", () => {
    // c3 is a tier 3 customer with two set prices: which of them B's tier offer already covers decides A's offer
    mockCustomers = [
      {
        customerId: "c3",
        name: "Eastside",
        tier: 3,
        orderUnit: "case",
        set: { piece: 0.5, case: 13 },
      },
    ];
    mount();
    act(() => draft.startEditing());
    // B: a tier offer ticked
    act(() => void draft.editCell("case", 2, "5"));
    act(() =>
      draft.setOfferTicked(
        draft.plan!.plan.offers.findIndex((o) => o.kind === "tier"),
        true,
      ),
    );
    // A: its customer offer ticked (worked out on a ladder that holds B and B's tier offer)
    act(() => void draft.editCell("case", 1, "20"));
    act(() => draft.setOfferTicked(customerIdx(), true));
    expect(customerMoves()!.length).toBeGreaterThan(0);
    expect(draft.notice).toBeNull();
    // re-typing B clears B's ticked tier offer (its own notice) and changes the ladder A's moves were worked out on
    act(() => void draft.editCell("case", 2, "6"));
    expect(customerMoves()).toEqual([]);
    expect(draft.notice).toContain("was cleared because you changed that price again.");
    expect(draft.notice).toContain(NOTICE);
    const shown = screen.getByTestId(T.ebNotice).textContent;
    expect(shown).toContain("you changed that price again");
    expect(shown).toContain("Tick it again to use the new prices.");
  });

  it("canSave also waits for the customers query: off while it fetches, on again after", () => {
    mockCustomers = [];
    const { again } = mount();
    act(() => draft.startEditing());
    act(() => void draft.editCell("case", 2, "14.5"));
    expect(draft.canSave).toBe(true);
    mockCustomersFetching = true;
    again();
    expect(draft.canSave).toBe(false);
    expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).toBe("true");
    mockCustomersFetching = false;
    again();
    expect(draft.canSave).toBe(true);
    expect(screen.getByTestId(T.ebSave).getAttribute("aria-disabled")).not.toBe("true");
  });

  describe("Reload and Discard refetch the customers too", () => {
    it("Reload prices invalidates the customer prices key, the one Change prices and cell edits read", async () => {
      mockError = STALE;
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      mount();
      act(() => draft.startEditing());
      act(() => void draft.editCell("case", 2, "14.5"));
      await user.click(screen.getByRole("button", { name: "Reload prices" }));
      expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
      expect(spy).toHaveBeenCalledWith({ queryKey: productCustomerPricesKey("p1") });
    });

    it("Discard after a stale save invalidates it as well; a plain Discard touches neither", async () => {
      mockError = STALE;
      const spy = jest.spyOn(mockQc, "invalidateQueries");
      const user = userEvent.setup();
      mount();
      act(() => draft.startEditing());
      act(() => void draft.editCell("case", 2, "14.5"));
      await user.click(screen.getByTestId(T.ebCancel));
      await user.click(screen.getByTestId(T.ebDiscard));
      expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
      expect(spy).toHaveBeenCalledWith({ queryKey: productCustomerPricesKey("p1") });
    });
  });
});
