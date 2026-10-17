import { render, screen, fireEvent } from "@testing-library/react";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { VIEW } from "./plan.test-utils";

// The one spec with the real pricing core: nothing mocked but the hooks around it.
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

it("raising the Case by 5% writes the Case Retail the core worked out", () => {
  render(<ChangePricesPanel onClose={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  expect(screen.getByTestId("units-v2-ch-preview")).toHaveTextContent("$14.61");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(draft.applyPlan.mock.calls[0][0].patches).toEqual([{ ref: "case", tier: 1, to: 14.61 }]);
});

it("K3b: Apply also hands the draft a re-planner, so the customer offer can follow the customers' prices", () => {
  render(<ChangePricesPanel onClose={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  const [plan, replan] = draft.applyPlan.mock.calls.at(-1)!;
  const customer = { customerId: "c1", name: "A", tier: 1, orderUnit: null, set: { case: 13 } };
  const fresh = replan([customer]);
  // the same change, worked out again for the customers it is given
  expect(fresh.patches).toEqual(plan.patches);
  expect(fresh.offers).toEqual([
    expect.objectContaining({
      kind: "customer",
      moves: [expect.objectContaining({ customerId: "c1", ref: "case", from: 13, to: 13.65 })],
    }),
  ]);
  expect(replan([]).offers).toEqual([]);
});
