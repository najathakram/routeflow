import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { planPriceChange } from "@routeflow/pricing";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { PLAN_TESTIDS as T } from "./plan-testids";
import { emptyPlan, longPlan, richPlan, VIEW } from "./plan.test-utils";

jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  planPriceChange: jest.fn(),
}));
const draft = {
  grid: { productId: "p1", revision: 7, tierRules: undefined } as Record<string, unknown>,
  view: VIEW as unknown,
  plan: null,
  applyPlan: jest.fn(),
  setOfferTicked: jest.fn(),
  keepCustomer: jest.fn(),
};
jest.mock("../edit/usePriceDraft", () => ({ usePriceDraft: () => draft }));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
const customers = [{ customerId: "c1", name: "Northside", tier: 1, orderUnit: null, set: {} }];
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({ data: { customers } }),
}));

const plan = planPriceChange as jest.Mock;
const mount = (onClose = jest.fn()) => render(<ChangePricesPanel onClose={onClose} />);
const type = (v: string) =>
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: v } });
const apply = () => fireEvent.click(screen.getByRole("button", { name: "Apply" }));

beforeEach(() => {
  draft.view = VIEW;
  draft.applyPlan.mockReset();
  draft.setOfferTicked.mockReset();
  draft.keepCustomer.mockReset();
  plan.mockReset().mockReturnValue(richPlan());
});

describe("ChangePricesPanel (V03, V05, V18)", () => {
  it("titles the panel and gives Raise and Lower equal-width segments (V18)", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Change prices" })).toBeInTheDocument();
    for (const name of ["Raise", "Lower"]) {
      const label = screen.getByText(name, { selector: "label" });
      expect(label.className).toContain("flex-1");
      expect(label.className).toContain("basis-0");
    }
  });

  it("asks planPriceChange for every price and shows what it returns", () => {
    mount();
    expect(plan).not.toHaveBeenCalled();
    type("5");
    expect(plan).toHaveBeenLastCalledWith(
      VIEW,
      { unit: "case", direction: "raise", mode: "percent", value: 5, also: false },
      undefined,
      expect.any(Function),
      { customers },
    );
    expect(screen.getByTestId(T.changePreview)).toHaveTextContent("$14.60");
    expect(screen.getByTestId(T.changePreview)).toHaveTextContent("$13.91");
  });

  it.each([
    ["1,5", NaN],
    ["0x10", NaN],
    ["1e2", NaN],
    ["1,000", 1000],
    ["5%", 5],
    [" $2.50 ", 2.5],
  ])("reads %j as %p", (text, value) => {
    mount();
    type(text);
    fireEvent.blur(screen.getByLabelText("Amount"));
    expect(plan).toHaveBeenLastCalledWith(
      VIEW,
      expect.objectContaining({ value }),
      undefined,
      expect.any(Function),
      expect.anything(),
    );
  });

  it("does not flash 'above zero' on the 0 of 0.5, and says it once the field is left", () => {
    plan.mockReturnValue(emptyPlan({ problems: ["Enter an amount above zero."] }));
    mount();
    type("0");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(plan).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText("Amount"));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount above zero.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("passes also: true only after the owner ticks the prices they set, and shows the parsed value", () => {
    mount();
    type("5%");
    const also = screen.getByRole("checkbox", { name: /Also raise the prices you set/ });
    expect(also).not.toBeChecked();
    expect(also.closest("label")).toHaveTextContent(", by 5%.");
    fireEvent.click(also);
    expect(plan).toHaveBeenLastCalledWith(
      VIEW,
      expect.objectContaining({ also: true }),
      undefined,
      expect.any(Function),
      expect.anything(),
    );
  });

  it("never pre-selects the customer opt-in, and lists every customer move grouped", () => {
    mount();
    type("5");
    expect(
      screen.getByRole("checkbox", { name: /prices set for these customers/i }),
    ).not.toBeChecked();
    expect(screen.getAllByTestId(T.customerRow)).toHaveLength(4);
    expect(screen.getByTestId(T.againstSummary)).toBeInTheDocument();
  });

  it("F02: Apply and Cancel sit below the preview in normal flow, on the card background, so no row is under them", () => {
    plan.mockReturnValue(longPlan(40));
    mount();
    type("5");
    const preview = screen.getByTestId(T.changePreview);
    expect(within(preview).getAllByRole("row")).toHaveLength(40);
    const footer = screen.getByTestId(T.changeFooter);
    // not sticky: a sticky row stops at #main-content's pb-24 and lands on the preview table's last rows
    expect(footer.className).not.toMatch(/\b(sticky|fixed|absolute)\b/);
    expect(footer.style.bottom).toBe("");
    expect(footer.className).toContain("bg-white");
    expect(preview.compareDocumentPosition(footer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(footer).getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(within(footer).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("F02: the Also update box grows to its content: nothing on it or above it clips, clamps or caps the height", () => {
    mount();
    type("5%");
    const box = screen.getByTestId(T.alsoUpdate);
    const clip = /\b(overflow-hidden|overflow-y-hidden|truncate|max-h-\S+|h-\d\S*|line-clamp-\d)\b/;
    for (let el: HTMLElement | null = box; el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toMatch(clip);
      expect(el.style.maxHeight).toBe("");
      expect(el.style.height).toBe("");
    }
    expect(box).toHaveTextContent("Also raise the prices you set");
    expect(box).toHaveTextContent("Case Tier 2 $12.50");
  });

  it("P13: only the chosen Raise/Lower half is filled; the other is outlined, and the choice is announced", () => {
    mount();
    const half = (name: string) => screen.getByText(name, { selector: "label" });
    const radio = (name: string) => screen.getByRole("radio", { name });
    expect(half("Raise").className).toContain("bg-accent-strong");
    expect(half("Lower").className).not.toContain("bg-accent-strong");
    expect(half("Lower").className).toContain("border");
    expect(radio("Raise")).toHaveAttribute("aria-checked", "true");
    expect(radio("Lower")).toHaveAttribute("aria-checked", "false");
    // the fill is never driven by `peer-checked:`: a later sibling label would match the checked radio before it
    expect(half("Raise").className).not.toContain("peer-checked");
    expect(half("Lower").className).not.toContain("peer-checked");
    fireEvent.click(radio("Lower"));
    expect(half("Lower").className).toContain("bg-accent-strong");
    expect(half("Raise").className).not.toContain("bg-accent-strong");
    expect(radio("Lower")).toHaveAttribute("aria-checked", "true");
    expect(radio("Raise")).toHaveAttribute("aria-checked", "false");
  });

  it("disables Apply and does not plan until an amount is typed", () => {
    mount();
    expect(plan).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("folds the plan and only the ticked offers into the draft", () => {
    const onClose = jest.fn();
    mount(onClose);
    type("5");
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3 to \$14.60 too/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /prices set for these customers/i }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: /^Keep .*Can at \$1\.13$/ })[0]);
    apply();
    const folded = draft.applyPlan.mock.calls[0][0];
    expect(folded.patches).toEqual([
      { ref: "case", tier: 1, to: 14.6 },
      { ref: "case", tier: 3, to: 14.6 },
    ]);
    expect(folded.offers.map((o: { kind: string }) => o.kind)).toEqual(["customer"]);
    expect(draft.setOfferTicked).toHaveBeenCalledWith(0, true);
    expect(draft.keepCustomer).toHaveBeenCalledWith({
      customerId: "c1",
      ref: "can",
      tier: 1,
      from: null,
      to: 1.13,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("folds nothing optional when nothing was ticked", () => {
    mount();
    type("5");
    apply();
    expect(draft.applyPlan.mock.calls[0][0].patches).toEqual([{ ref: "case", tier: 1, to: 14.6 }]);
    expect(draft.setOfferTicked).not.toHaveBeenCalled();
    expect(draft.keepCustomer).not.toHaveBeenCalled();
  });

  it("clears every tick when the view changes (a new plan is never pre-selected)", () => {
    const { rerender } = mount();
    type("5");
    fireEvent.click(screen.getByRole("checkbox", { name: /Also raise the prices you set/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3/ }));
    expect(screen.getByRole("checkbox", { name: /Set Tier 3/ })).toBeChecked();
    draft.view = { ...VIEW, rows: [...VIEW.rows] };
    rerender(<ChangePricesPanel onClose={jest.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Set Tier 3/ })).not.toBeChecked();
  });

  it("closes on Cancel (Escape is the shared stack's, wired by ChangePrices: V17)", () => {
    const onClose = jest.fn();
    mount(onClose);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByTestId(T.changePanel), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus when it opens, so Escape works from the keyboard", () => {
    mount();
    expect(screen.getByTestId(T.changePanel)).toHaveFocus();
  });
});
