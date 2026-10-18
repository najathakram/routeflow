import * as React from "react";
import { act, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { customerChange, emptyPlan } from "../change-prices/plan.test-utils";
import { keepMove } from "../change-prices/selection";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { PriceEditBar } from "./PriceEditBar";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";

// F03: after Change prices Apply the price boxes show the applied draft values (not the old ones with the new price as
// a faint hint). NIT-1: a Keep the owner's own action removes is not "because that customer's prices changed".
// Item 7: tier 1 is the tenant's own label in the draft's names.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let mockLabels: Record<string, string> = {};
let mockCustomers: unknown[] = [];
const mockSave = jest.fn();
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({
    mutate: (req: unknown, o: unknown) => mockSave(req, o),
    reset: jest.fn(),
    isPending: false,
    error: null,
  }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: mockLabels }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: mockCustomers }, isFetching: false }),
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
      cells: cells([30, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
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
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

let draft!: PriceDraft;
const Probe = () => {
  draft = usePriceDraft();
  return null;
};
const tree = () => (
  <QueryClientProvider client={new QueryClient()}>
    <PriceDraftProvider productId="p1">
      <Probe />
      <EditablePricesGrid product={product} />
      <PriceEditBar />
    </PriceDraftProvider>
  </QueryClientProvider>
);
const mount = () => {
  const r = rtlRender(tree());
  return { ...r, again: () => r.rerender(tree()) };
};
const input = (ref: string, tier: number) =>
  within(screen.getByTestId(T.row(ref))).getByTestId(T.input(ref, tier)) as HTMLInputElement;

beforeEach(() => {
  mockSave.mockReset();
  mockLabels = {};
  mockCustomers = [];
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("F03: Apply writes the applied values into the price boxes", () => {
  // What Change prices Apply hands over: the Case Retail 30 to 31.5 (a Set price), Wholesale 13.91 to 14.6.
  const applied = emptyPlan({
    patches: [
      { ref: "case", tier: 1, to: 31.5 },
      { ref: "case", tier: 2, to: 14.6 },
      { ref: "case", tier: 3, to: 13.1 },
    ],
    changes: [
      { ref: "case", label: "Case", tier: 1, from: 30, to: 31.5 },
      { ref: "case", label: "Case", tier: 2, from: 13.91, to: 14.6 },
      { ref: "case", label: "Case", tier: 3, from: 12.5, to: 13.1 },
    ],
  });
  const apply = () => act(() => draft.applyPlan(applied, () => applied));

  it("the Retail box that read 30 reads 31.5, Wholesale 14.6, and an Auto cell the plan set shows its new Set price", () => {
    mount();
    expect(draft.count).toBe(0);
    apply();
    expect(draft.editing).toBe(true);
    expect(draft.count).toBe(3);
    expect(input("case", 1).value).toBe("31.50");
    expect(input("case", 2).value).toBe("14.60");
    expect(input("case", 3).value).toBe("13.10");
    // a price the plan did not touch is still what it was
    expect(input("case", 4).value).toBe("");
    expect(input("piece", 1).value).toBe("0.92");
  });

  it("the changed boxes are marked as changed, the untouched ones are not", () => {
    mount();
    apply();
    expect(draft.api.changed("case", 1)).toBe(true);
    expect(draft.api.changed("case", 3)).toBe(true);
    expect(draft.api.changed("case", 4)).toBe(false);
    expect(input("case", 1).className).toMatch(/(^|\s)border-brand-500/);
    expect(input("case", 4).className).not.toMatch(/(^|\s)border-brand-500/);
  });

  it("a box the owner then edits shows what they typed, and Save carries it", async () => {
    const user = userEvent.setup();
    mount();
    apply();
    await user.clear(input("case", 1));
    await user.type(input("case", 1), "32");
    expect(input("case", 1).value).toBe("32");
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 1, to: 32 });
  });

  it("typing a box back to its saved price takes it out of the draft instead of leaving the applied one", async () => {
    const user = userEvent.setup();
    mount();
    apply();
    await user.clear(input("case", 1));
    await user.type(input("case", 1), "30");
    expect(input("case", 1).value).toBe("30");
    expect(draft.toRequest()?.patches.map((p) => `${p.ref}|${p.tier}`)).not.toContain("case|1");
    expect(draft.count).toBe(2);
  });

  it("MUST: a price typed BEFORE the plan shows the plan's value, which is what Save writes", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await user.clear(input("case", 1));
    await user.type(input("case", 1), "32");
    expect(input("case", 1).value).toBe("32");
    const raised = emptyPlan({
      patches: [{ ref: "case", tier: 1, to: 35.2 }],
      changes: [{ ref: "case", label: "Case", tier: 1, from: 30, to: 35.2 }],
    });
    act(() => draft.applyPlan(raised, () => raised));
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 1, to: 35.2 });
    expect(input("case", 1).value).toBe("35.20");
  });

  it("MUST: a price typed before a tier offer is ticked shows the offer's value, which is what Save writes", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await user.clear(input("case", 3));
    await user.type(input("case", 3), "12");
    expect(input("case", 3).value).toBe("12");
    const withOffer = emptyPlan({
      patches: [{ ref: "case", tier: 2, to: 14 }],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
      offers: [
        {
          kind: "tier",
          ticked: false,
          ref: "case",
          tier: 2,
          tiers: [3],
          value: 14,
          warning: "Tier 3 is higher than Wholesale ($14.00).",
          title: "Set Tier 3 to $13.10 too",
          patches: [{ ref: "case", tier: 3, to: 13.1 }],
        },
      ],
    });
    act(() => draft.applyPlan(withOffer, () => withOffer));
    // the typed 12 is still its own value until the offer is ticked
    expect(input("case", 3).value).toBe("12");
    act(() => draft.setOfferTicked(0, true));
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 3, to: 13.1 });
    expect(input("case", 3).value).toBe("13.10");
  });

  it("a price typed AFTER the plan still wins over the plan's value", async () => {
    const user = userEvent.setup();
    mount();
    apply();
    await user.clear(input("case", 1));
    await user.type(input("case", 1), "40");
    expect(input("case", 1).value).toBe("40");
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 1, to: 40 });
  });

  it("Cancel drops the applied values: the boxes go back to the saved prices", async () => {
    const user = userEvent.setup();
    mount();
    apply();
    await user.click(screen.getByTestId(T.ebCancel));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getByTestId(T.btnEdit));
    expect(input("case", 1).value).toBe("30.00");
  });

  it("an Auto price the plan set back to Auto shows an empty box", () => {
    mount();
    const toAuto = emptyPlan({
      patches: [{ ref: "case", tier: 2, to: null }],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 12.5 }],
    });
    act(() => draft.applyPlan(toAuto, () => toAuto));
    expect(input("case", 2).value).toBe("");
  });
});

describe("item 7: tier 1 is the tenant's own label in the draft", () => {
  it("is Retail until the tenant relabels it, and then the tenant's label (the save bar's problems say it too)", () => {
    const { again } = mount();
    expect(draft.tierName(1)).toBe("Retail");
    mockLabels = { "1": "Standard", "2": "Wholesale" };
    again();
    expect(draft.tierName(1)).toBe("Standard");
    expect(draft.tierName(2)).toBe("Wholesale");
    expect(draft.tierName(4)).toBe("Tier 4");
  });

  it("a Standard Case price the owner types wrong is named Standard Case in the bar", async () => {
    mockLabels = { "1": "Standard" };
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await user.type(input("case", 1), "x");
    expect(screen.getByTestId(T.ebProblems).textContent).toMatch(/^Standard Case: /);
  });
});

describe("K3b NIT-1: a Keep the owner's own action clears is not blamed on the customer's prices", () => {
  const BLAMES_PRICES = "that customer's prices changed";
  const UNDONE =
    "Your earlier choice to keep a customer price was cleared because that price change was undone.";
  // c1 pays a set Piece price, so its Case price is derived from it: a Keep on that Case row pins the derived price.
  const base = {
    customerId: "c1",
    name: "Northside",
    tier: 2,
    orderUnit: "piece",
    set: { piece: 0.5 },
  };
  const start = () => {
    mockCustomers = [base];
    const view = mount();
    act(() => draft.startEditing());
    act(() => void draft.editCell("case", 2, "14.5"));
    const row = draft.plan!.plan.customerChanges.find(
      (c) => c.customerId === "c1" && c.ref === "case",
    )!;
    const keep = keepMove(row);
    act(() => draft.keepCustomer(keep));
    expect(draft.toRequest()?.customerMoves).toEqual([keep]);
    return { ...view, keep };
  };

  it("resetting every price to Auto removes the applied plan a Keep was made on, so the Keep goes, said as undone", () => {
    // c2 has no price of its own: the applied plan shows its derived Case price (9 now), which a Keep pins
    const plan = emptyPlan({
      patches: [{ ref: "case", tier: 2, to: 14 }],
      customerChanges: [customerChange(2, { ref: "case", tier: 1, from: 9, to: 9.5 })],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
    });
    mockCustomers = [{ customerId: "c2", name: "Southside", tier: 1, orderUnit: null, set: {} }];
    mount();
    act(() => draft.applyPlan(plan, () => plan));
    const keep = { customerId: "c2", ref: "case", tier: 1, from: null, to: 9 };
    act(() => draft.keepCustomer(keep));
    expect(draft.toRequest()?.customerMoves).toEqual([keep]);
    act(() => draft.resetAllToAuto());
    expect(draft.toRequest()?.customerMoves).toEqual([]);
    expect(draft.notice).toBe(UNDONE);
    expect(draft.notice).not.toContain(BLAMES_PRICES);
  });

  it("setting the cell back to its saved price clears the Keep and says the price change was undone", () => {
    start();
    act(() => draft.api.setText("case", 2, "13.91", "13.91"));
    expect(draft.toRequest()?.customerMoves).toEqual([]);
    expect(draft.notice).toBe(UNDONE);
    expect(draft.notice).not.toContain(BLAMES_PRICES);
  });

  it("another user changing the customer still says the customer's prices changed", () => {
    const { again } = start();
    mockCustomers = [{ ...base, set: { piece: 0.6 } }];
    again();
    expect(draft.toRequest()?.customerMoves).toEqual([]);
    expect(draft.notice).toBe(
      "Your earlier choice to keep a customer price was cleared because that customer's prices changed.",
    );
  });

  it("a Keep whose price change is still in the draft stays, with no notice", () => {
    const { keep } = start();
    act(() => draft.api.setText("case", 3, "12", "12.5"));
    expect(draft.toRequest()?.customerMoves).toEqual([keep]);
    expect(draft.notice).toBeNull();
  });

  it("an offer cleared by the same action keeps its own copy, and the Keep line joins it", () => {
    mockCustomers = [{ ...base, orderUnit: "case" }];
    mount();
    act(() => draft.startEditing());
    act(() => void draft.editCell("case", 2, "14.5"));
    const idx = draft.plan!.plan.offers.findIndex((o) => o.kind === "customer");
    act(() => draft.setOfferTicked(idx, true));
    const row = draft.plan!.plan.customerChanges.find((c) => c.ref === "case");
    if (row) act(() => draft.keepCustomer(keepMove(row)));
    act(() => draft.resetAllToAuto());
    expect(draft.notice).toMatch(/was cleared because you reset every price to Auto/);
    expect(draft.notice).not.toContain(BLAMES_PRICES);
  });
});

// The order of the draft decides the box, the problems and the request, and all three must agree.
describe("entry order: the box text equals the request value", () => {
  const tierOffer = (value: number) =>
    emptyPlan({
      patches: [{ ref: "case", tier: 2, to: 14 }],
      changes: [{ ref: "case", label: "Case", tier: 2, from: 13.91, to: 14 }],
      offers: [
        {
          kind: "tier",
          ticked: false,
          ref: "case",
          tier: 2,
          tiers: [3],
          value: 14,
          warning: "Tier 3 is higher than Wholesale ($14.00).",
          title: `Set Tier 3 to $${value} too`,
          patches: [{ ref: "case", tier: 3, to: value }],
        },
      ],
    });
  const planTo = (ref: string, tier: 1 | 2 | 3, to: number | null) =>
    emptyPlan({
      patches: [{ ref, tier, to }],
      changes: [{ ref, label: "Case", tier, from: 30, to: to ?? 0 }],
    });
  const typeInto = async (user: ReturnType<typeof userEvent.setup>, tier: number, text: string) => {
    const box = input("case", tier);
    await user.clear(box);
    if (text) await user.type(box, text);
  };
  const sent = (tier: number) =>
    draft.toRequest()?.patches.find((p) => p.ref === "case" && p.tier === tier);

  it("MUST: a refused text is dropped when a later plan patches the cell: box, problems, canSave and Save agree", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await typeInto(user, 1, "abc");
    expect(draft.problems).toHaveLength(1);
    expect(draft.canSave).toBe(false);
    const plan = planTo("case", 1, 33);
    act(() => draft.applyPlan(plan, () => plan));
    expect(input("case", 1).value).toBe("33.00");
    expect(draft.problems).toEqual([]);
    expect(input("case", 1).getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText(/Enter a price like/)).toBeNull();
    expect(draft.canSave).toBe(true);
    expect(sent(1)).toEqual({ ref: "case", tier: 1, to: 33 });
  });

  it("MUST: a refused text comes back, with its problem, when the offer that covered it is unticked", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await typeInto(user, 3, "abc");
    const plan = tierOffer(13.1);
    act(() => draft.applyPlan(plan, () => plan));
    expect(draft.problems).toHaveLength(1);
    act(() => draft.setOfferTicked(0, true));
    expect(input("case", 3).value).toBe("13.10");
    expect(draft.problems).toEqual([]);
    expect(draft.canSave).toBe(true);
    expect(sent(3)).toEqual({ ref: "case", tier: 3, to: 13.1 });
    act(() => draft.setOfferTicked(0, false));
    expect(input("case", 3).value).toBe("abc");
    expect(draft.problems).toHaveLength(1);
    expect(draft.problems[0]).toMatchObject({ ref: "case", tier: 3 });
    expect(draft.canSave).toBe(false);
  });

  it("an offer unticked after a typed cell: the typed text comes back and Save sends it", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await typeInto(user, 3, "12");
    const plan = tierOffer(13.1);
    act(() => draft.applyPlan(plan, () => plan));
    act(() => draft.setOfferTicked(0, true));
    expect(input("case", 3).value).toBe("13.10");
    expect(sent(3)?.to).toBe(13.1);
    act(() => draft.setOfferTicked(0, false));
    expect(input("case", 3).value).toBe("12");
    expect(sent(3)).toEqual({ ref: "case", tier: 3, to: 12 });
  });

  it("two plans on one cell: the later plan's value", () => {
    mount();
    const first = planTo("case", 1, 31.5);
    const second = planTo("case", 1, 33);
    act(() => draft.applyPlan(first, () => first));
    expect(input("case", 1).value).toBe("31.50");
    act(() => draft.applyPlan(second, () => second));
    expect(input("case", 1).value).toBe("33.00");
    expect(sent(1)?.to).toBe(33);
  });

  it("cleared to Auto after a plan: the box is empty and Save sends to: null", async () => {
    const user = userEvent.setup();
    mount();
    const plan = planTo("case", 2, 14.6);
    act(() => draft.applyPlan(plan, () => plan));
    expect(input("case", 2).value).toBe("14.60");
    await typeInto(user, 2, "");
    expect(input("case", 2).value).toBe("");
    expect(sent(2)).toEqual({ ref: "case", tier: 2, to: null });
  });

  it("re-typed after a later plan: the typed value wins in the box and in Save", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    await typeInto(user, 1, "32");
    const plan = planTo("case", 1, 35.2);
    act(() => draft.applyPlan(plan, () => plan));
    expect(input("case", 1).value).toBe("35.20");
    await typeInto(user, 1, "40");
    expect(input("case", 1).value).toBe("40");
    expect(sent(1)?.to).toBe(40);
  });

  it("after a save and an Undo the grid is replaced: the draft is empty and the boxes show the grid", async () => {
    const user = userEvent.setup();
    const { again } = mount();
    const plan = planTo("case", 1, 35.2);
    act(() => draft.applyPlan(plan, () => plan));
    expect(input("case", 1).value).toBe("35.20");
    const saved: ProductPriceGridDto = {
      ...grid,
      revision: 8,
      priceState: "ps-2",
      rows: grid.rows.map((r) =>
        r.ref === "case"
          ? { ...r, cells: r.cells.map((c) => (c.tier === 1 ? { ...c, value: 35.2 } : c)) }
          : r,
      ),
    };
    mockSave.mockImplementation((_req, o: { onSuccess: (r: unknown) => void }) => {
      mockGrid = { data: saved, isLoading: false, isError: false };
      o.onSuccess({
        auditId: "a1",
        revision: 8,
        undo: { patches: [], customerMoves: [] },
        grid: saved,
      });
    });
    await user.click(screen.getByTestId(T.ebSave));
    again();
    expect(draft.editing).toBe(false);
    expect(draft.count).toBe(0);
    // the Undo replaces the grid again (setQueryData): the saved prices are back to the original
    mockGrid = { data: grid, isLoading: false, isError: false };
    again();
    await user.click(screen.getByTestId(T.btnEdit));
    expect(draft.count).toBe(0);
    expect(draft.toRequest()?.patches).toEqual([]);
    expect(input("case", 1).value).toBe("30.00");
    expect(input("case", 2).value).toBe("13.91");
    expect(input("piece", 1).value).toBe("0.92");
  });
});

// K11 L2 fold M1 (money entry): a box a plan filled shows canonical two-decimal text, and focusing it then typing
// REPLACES the value (31.5 + "32" was "31.532", staged silently as $31.53).
describe("M1: a box Change prices filled is replaced by typing, never appended to", () => {
  const raise = emptyPlan({
    patches: [{ ref: "case", tier: 1, to: 31.5 }],
    changes: [{ ref: "case", label: "Case", tier: 1, from: 30, to: 31.5 }],
  });
  const filled = () => act(() => draft.applyPlan(raise, () => raise));
  const refocus = () => {
    act(() => input("case", 1).blur());
    act(() => input("case", 1).focus());
  };

  it("the filled box displays 31.50 (focused or not) while the staged number stays exactly 31.5", () => {
    mount();
    filled();
    expect(input("case", 1).value).toBe("31.50");
    refocus();
    expect(input("case", 1).value).toBe("31.50");
    act(() => input("case", 1).blur());
    expect(input("case", 1).value).toBe("31.50");
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 1, to: 31.5 });
    expect(draft.count).toBe(1);
  });

  it("focus then type 32: the value is 32, not 31.532, and 32 is what Save carries", async () => {
    const user = userEvent.setup();
    mount();
    filled();
    refocus();
    await user.keyboard("32");
    expect(input("case", 1).value).toBe("32");
    expect(draft.toRequest()?.patches).toContainEqual({ ref: "case", tier: 1, to: 32 });
  });

  it("a text the draft holds un-settled (31.5, not yet 31.50) still gets selected whole on focus", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    act(() => {
      draft.editCell("case", 2, "13.5");
    });
    act(() => input("case", 2).focus());
    expect(input("case", 2).value).toBe("13.5");
    expect(input("case", 2).selectionStart).toBe(0);
    expect(input("case", 2).selectionEnd).toBe("13.5".length);
    await user.keyboard("14");
    expect(input("case", 2).value).toBe("14");
  });

  it("typing the saved price back (30.00) is no change, and Escape restores the filled text", async () => {
    const user = userEvent.setup();
    mount();
    filled();
    refocus();
    await user.keyboard("{Escape}");
    expect(input("case", 1).value).toBe("31.50");
    await user.keyboard("30.00");
    await user.tab();
    expect(draft.toRequest()?.patches.map((p) => `${p.ref}|${p.tier}`)).not.toContain("case|1");
    expect(draft.count).toBe(0);
  });
});
