import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  buildLadderView,
  refForLabel,
  type LadderProduct,
  type LadderViewUnit,
} from "@routeflow/pricing";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { PLAN_TESTIDS as T } from "./plan-testids";

// SA-798a with the real pricing core: a Wholesale customer's set Can price moves the other way, so the opt-in reads
// "Also update ..." (the core's title, as-is), starts unticked, and the move is marked with its cause.
const lvl = (label: string, factorToBase: number, price: string | null): LadderViewUnit => ({
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const product = { unit: "Case", unitsPerBox: 50, pricePerUnit: "60.00", priceTier2: "55.00" };
const units = [lvl("Roll", 5, "6.00"), lvl("Can", 1, "1.25")];
const roll = refForLabel(product as LadderProduct, units, "Roll");
const can = refForLabel(product as LadderProduct, units, "Can");
const VIEW = buildLadderView(product as LadderProduct, units, { orderUnit: roll, packAuto: 1 });

const draft = {
  grid: { productId: "p1", revision: 7, tierRules: { 2: 8 } },
  view: VIEW,
  plan: null,
  applyPlan: jest.fn(),
  setOfferTicked: jest.fn(),
  keepCustomer: jest.fn(),
};
jest.mock("../edit/usePriceDraft", () => ({ usePriceDraft: () => draft }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale" } }),
}));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({
    data: {
      customers: [
        { customerId: "acme", name: "Acme", tier: 2, orderUnit: "pack", set: { [can]: 1.1 } },
      ],
    },
  }),
}));

it("a move against the change reads 'Also update', is unticked, and the move carries its cause", () => {
  render(<ChangePricesPanel onClose={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Unit"), { target: { value: roll } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  const offers = screen.getByTestId(T.alsoUpdate);
  expect(
    within(offers).getByText(
      "Also update prices set for these customers, in step with their tier (1 price).",
    ),
  ).toBeTruthy();
  within(offers)
    .getAllByRole("checkbox")
    .forEach((b) => expect(b).not.toBeChecked());
  const move = within(offers).getByTestId(T.offerMove);
  expect(move.getAttribute("data-against")).toBe("true");
  expect(move.textContent).toContain("Acme, Can");
  expect(move.textContent).toContain("does not move the same way");
});
