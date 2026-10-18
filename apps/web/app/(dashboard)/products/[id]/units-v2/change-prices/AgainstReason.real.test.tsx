import { render, screen, fireEvent, within } from "@testing-library/react";
import { buildLadderView, type LadderProduct } from "@routeflow/pricing";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { PLAN_TESTIDS as T } from "./plan-testids";

// K11-17 with the real pricing core: a Raise whose preview shows a LOWER price says why on that row, under the row.
// The K9 fixture: Case $30.00 / Tier 2 $28.00 (both set), Piece Retail set $1.50, Piece Tier 2 Auto $1.40.
const product = { unit: "Case", unitsPerBox: 24, pricePerUnit: "30.00", priceTier2: "28.00" };
const piece = {
  label: "Piece",
  factorToBase: 1,
  price: "1.50",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const VIEW = buildLadderView(product as LadderProduct, [piece]);
const draft = {
  grid: { productId: "p1", revision: 7, tierRules: {} },
  view: VIEW,
  plan: null,
  applyPlan: jest.fn(),
  setOfferTicked: jest.fn(),
  keepCustomer: jest.fn(),
};
jest.mock("../edit/usePriceDraft", () => ({ usePriceDraft: () => draft }));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: { "2": "Tier 2" } }) }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({ data: { customers: [] } }),
}));

const preview = () => screen.getByTestId(T.changePreview);
const groupOf = (name: RegExp) =>
  within(preview()).getByRole("rowheader", { name }).closest("tbody")!;
const raiseCase = () => {
  render(<ChangePricesPanel onClose={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "pack" } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
};

it("Raise Case 5%: the Tier 2 Piece row is against, and its reason names Retail Piece $1.50", () => {
  raiseCase();
  const row = groupOf(/Tier 2 Piece/);
  expect(row.getAttribute("data-against")).toBe("true");
  expect(within(row).getByText("$1.40")).toBeTruthy();
  expect(within(row).getByText("$1.33")).toBeTruthy();
  expect(row.textContent).toContain("Retail Piece $1.50");
  expect(row.textContent).toContain('Tick "Also raise the prices you set" to move it.');
  // the reason is its own row under the figures, never a cell beside them
  const rows = row.querySelectorAll("tr");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).not.toContain("Follows");
  expect(rows[1].textContent).toContain("Follows");
});

it("rows that go the right way have no reason line", () => {
  raiseCase();
  const ok = groupOf(/Retail Case/);
  expect(ok.getAttribute("data-against")).toBe("false");
  expect(ok.querySelectorAll("tr")).toHaveLength(1);
  expect(ok.textContent).not.toContain("Follows");
});

it("rule: no preview row with a lower price on a Raise renders without a reason line", () => {
  raiseCase();
  for (const g of preview().querySelectorAll("tbody")) {
    const [, from, to] = [...g.querySelectorAll("tr:first-child > *")].map(
      (c) => c.textContent ?? "",
    );
    const down = Number(to.replace("$", "")) < Number(from.replace("$", ""));
    if (down) expect(g.querySelectorAll("tr")).toHaveLength(2);
  }
  expect(preview().querySelectorAll('tbody[data-against="true"]').length).toBeGreaterThan(0);
});
