import { fireEvent, render, screen } from "@testing-library/react";
import { planPriceChange } from "@routeflow/pricing";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { longPlan, VIEW } from "./plan.test-utils";
import { PLAN_TESTIDS as T } from "./plan-testids";

jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  planPriceChange: jest.fn(),
}));

const draft = {
  grid: { productId: "p1", revision: 7 },
  view: VIEW,
  plan: null,
  applyPlan: jest.fn(),
  setOfferTicked: jest.fn(),
  keepCustomer: jest.fn(),
};
jest.mock("../edit/usePriceDraft", () => ({ usePriceDraft: () => draft }));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({ data: { customers: [] } }),
}));

// K13 F03: a long preview pushed Apply below the floating window's fold. In the window (its own scroll area, its own
// pinned bar) the Apply / Cancel row sticks to the bottom of that area. On the page the shell's Save bar owns the
// bottom edge, so the row stays in the flow there.
describe("K13 F03: Apply / Cancel stay in view under a long preview", () => {
  it("sticks to the bottom of the window's scroll area", () => {
    render(<ChangePricesPanel onClose={jest.fn()} idSuffix="-w1" />);
    expect(screen.getByTestId("units-v2-change-footer").className).toMatch(
      /\bsticky\b.*\bbottom-0\b/,
    );
  });

  it("stays in the flow on the page", () => {
    render(<ChangePricesPanel onClose={jest.fn()} />);
    expect(screen.getByTestId("units-v2-change-footer").className).not.toMatch(/\bsticky\b/);
  });

  // On the page the Save bar owns the bottom edge, so a 15-row preview scrolls inside its own capped box and Apply sits
  // right under it.
  it("caps a long preview on the page with its own scroll; the window keeps the sticky row", () => {
    (planPriceChange as jest.Mock).mockReturnValue(longPlan(15));
    const { unmount } = render(<ChangePricesPanel onClose={jest.fn()} />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    const box = screen.getByTestId(T.changePreview).querySelector("table")!.parentElement!;
    expect(box.className).toMatch(/\bmax-h-\[\d+vh\]/);
    expect(box.className).toMatch(/\boverflow-auto\b/);
    unmount();
    render(<ChangePricesPanel onClose={jest.fn()} idSuffix="-w1" />);
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
    const wbox = screen.getByTestId(T.changePreview).querySelector("table")!.parentElement!;
    expect(wbox.className).not.toMatch(/max-h-/);
  });
});
