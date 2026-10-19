import { render, screen } from "@testing-library/react";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { VIEW } from "./plan.test-utils";

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
});
