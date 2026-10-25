import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { EditablePricesGrid } from "../edit/EditablePricesGrid";
import { PriceDraftProvider } from "../edit/PriceDraftProvider";
import { PriceEditBar } from "../edit/PriceEditBar";
import { usePriceDraft } from "../edit/usePriceDraft";
import { ChangePrices, useChangePrices } from "./ChangePrices";
import { PLAN_TESTIDS as P } from "./plan-testids";

// K11-15: Change prices Apply only stages. The bar says what is staged ("Case raised 5%: 2 prices ready. Save to
// keep them.") while the draft is exactly that, any later edit returns it to "{n} unsaved", and focus lands on Save.
// Cancel and Escape still return focus to the opener (V17). The real draft, grid, bar and panel; only the data hooks
// are mocked.

jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => ({ data: mockGrid, isLoading: false, isError: false }),
  fetchPriceGrid: () => Promise.resolve(mockGrid),
}));
jest.mock("@/lib/api/usePriceWrites", () => ({
  ...jest.requireActual("@/lib/api/usePriceWrites"),
  useSavePrices: () => ({ mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null }),
  useUndoPrices: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
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
const mockGrid: ProductPriceGridDto = {
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
      factor: 24,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([30, 28, 26, 24, 22], ["set", "set", "set"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([1.25, 1.17, 1.08, 1, 0.92], ["set"]),
    },
  ],
};
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "1.25" };

const seen: Array<{ count: number; lead: string | null }> = [];
function Probe() {
  const d = usePriceDraft();
  seen.push({ count: d.count, lead: d.appliedLead });
  return null;
}

function Harness() {
  const cp = useChangePrices();
  return (
    <PriceDraftProvider productId="p1">
      <EditablePricesGrid
        product={product}
        onOpenChangePrices={cp.toggle}
        changePricesOpen={cp.open}
        changePricesRef={cp.opener}
        panel={<ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />}
      />
      <Probe />
      <PriceEditBar changePricesOpen={cp.open} />
    </PriceDraftProvider>
  );
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
const raiseCaseFivePercent = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId(T.btnChange));
  await user.type(screen.getByLabelText("Amount"), "5");
  // Case is the first unit in the select; the form starts on the anchor (Piece), so pick Case.
  await user.selectOptions(screen.getByLabelText("Unit"), "case");
};
const barText = () => screen.getByTestId(T.ebText).textContent ?? "";

describe("K11-15: after Apply the bar says what is staged and focus goes to Save", () => {
  it("Raise Case 5% and Apply: the bar names the change and the count, and Save has focus", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByTestId(P.changePanel)).toBeNull();
    expect(within(screen.getByTestId(T.ebText)).getByText(/Case raised 5%/).textContent).toBe(
      "Case raised 5%: 1 price ready, and 2 Auto prices follow. Save to keep it.",
    );
    expect(barText()).not.toMatch(/unsaved/);
    expect(document.activeElement).toBe(document.getElementById(T.ebSave));
  });

  it("K12 F05: the bar names the Auto prices that follow, in the unit the panel counted", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    const willChange = Number(
      /(\d+) prices? will change/.exec(
        screen.getByText(/prices? will change/).textContent ?? "",
      )![1],
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const m =
      /^Case raised 5%: 1 price ready, and (\d+) Auto prices? follows?\. Save to keep it\./.exec(
        barText(),
      );
    expect(m).not.toBeNull();
    // Set + Auto = everything the panel said would change.
    expect(1 + Number(m![1])).toBe(willChange);
  });

  // K13 R3: at phone width the long sentence (with the Auto followers) beside Cancel and Save wrapped to three lines. Below
  // sm it takes the whole row and the buttons drop under it, so it holds two lines; the plain count stays beside them.
  it("below sm the sentence that names Auto followers takes its own row; the plain count does not", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(/Auto prices? follows?/);
    expect(screen.getByTestId(T.ebText).className).toContain("max-sm:basis-full");
    const box = within(screen.getByTestId(T.row("piece"))).getByTestId(
      T.input("piece", 2),
    ) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "1.1");
    expect(barText()).toMatch(/unsaved/);
    expect(screen.getByTestId(T.ebText).className).not.toContain("max-sm:basis-full");
  });

  it("no render shows staged prices without the sentence (no one-frame unsaved flash)", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    seen.length = 0;
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const staged = seen.filter((r) => r.count > 0);
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((r) => r.lead === "Case raised 5%")).toBe(true);
  });

  it("any later edit returns the bar to the plain count", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(/ready/);
    const box = within(screen.getByTestId(T.row("piece"))).getByTestId(
      T.input("piece", 2),
    ) as HTMLInputElement;
    await user.clear(box);
    await user.type(box, "1.1");
    expect(barText()).toMatch(/2 unsaved/);
    expect(barText()).not.toMatch(/ready/);
  });

  it("Lower by an amount reads in the same words", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnChange));
    await user.selectOptions(screen.getByLabelText("Unit"), "case");
    await user.click(screen.getByLabelText("Lower"));
    await user.selectOptions(screen.getByLabelText("By"), "amount");
    await user.type(screen.getByLabelText("Amount"), "0.5");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(
      /^Case lowered \$0\.50: \d+ prices? ready(?:, and \d+ Auto prices? follows?)?\. Save to keep /,
    );
  });

  it("says prices and 'them' when more than one is staged", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("checkbox", { name: /Also raise the prices you set/ }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(
      /^Case raised 5%: [2-9] prices ready(?:, and \d+ Auto prices? follows?)?\. Save to keep them\./,
    );
  });

  it("a second Apply on the same draft adds to the sentence", async () => {
    const user = userEvent.setup();
    mount();
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(/^Case raised 5% and Case raised 5%: /);
  });

  it("Apply after a hand edit keeps the plain count (the sentence would not cover the typed price)", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    const box = within(screen.getByTestId(T.row("piece"))).getByTestId(
      T.input("piece", 2),
    ) as HTMLInputElement;
    await user.type(box, "1.1");
    await raiseCaseFivePercent(user);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(barText()).toMatch(/^2 unsaved/);
  });

  it("Cancel returns focus to Change prices, Escape too", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnChange));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByTestId(T.btnChange));
    await user.click(screen.getByTestId(T.btnChange));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId(P.changePanel)).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId(T.btnChange));
  });
});
