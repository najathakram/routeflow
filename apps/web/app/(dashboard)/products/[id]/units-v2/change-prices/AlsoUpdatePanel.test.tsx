import { render, screen, fireEvent } from "@testing-library/react";
import { AlsoUpdatePanel } from "./AlsoUpdatePanel";
import { richPlan } from "./plan.test-utils";

const draft = {
  grid: { productId: "p1" },
  plan: null as null | Record<string, unknown>,
  setOfferTicked: jest.fn(),
  keep: jest.fn(),
  unkeep: jest.fn(),
  keepCustomer: jest.fn(),
};
jest.mock("../edit/usePriceDraft", () => ({ usePriceDraft: () => draft }));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale" } }),
}));
let mockTruncated: boolean | undefined;
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  useProductCustomerPrices: () => ({
    data: {
      customers: [{ customerId: "c1", name: "Northside", tier: 1, orderUnit: null, set: {} }],
      truncated: mockTruncated,
    },
  }),
}));

beforeEach(() => {
  mockTruncated = false;
  Object.values(draft).forEach((v) => typeof v === "function" && (v as jest.Mock).mockReset());
  draft.plan = { cell: { ref: "case", tier: 1 }, ticked: [], keeps: [], customerKeeps: [] };
});

describe("AlsoUpdatePanel (K3 mounts it with the draft's plan)", () => {
  it("heads the panel with the edited cell, old to new", () => {
    render(<AlsoUpdatePanel plan={richPlan()} />);
    expect(
      screen.getByRole("region", { name: "Retail Case: $13.91 to $14.60" }),
    ).toBeInTheDocument();
  });

  it("shows ticks from the draft and nothing ticked when the draft has none", () => {
    const { unmount } = render(<AlsoUpdatePanel plan={richPlan()} />);
    screen.getAllByRole("checkbox").forEach((b) => expect(b).not.toBeChecked());
    unmount();
    draft.plan = { ...draft.plan, ticked: [true, false] };
    render(<AlsoUpdatePanel plan={richPlan()} />);
    expect(screen.getByRole("checkbox", { name: /Set Tier 3/ })).toBeChecked();
  });

  it("writes ticks and Keeps into the draft, not anywhere else", () => {
    render(<AlsoUpdatePanel plan={richPlan()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3/ }));
    expect(draft.setOfferTicked).toHaveBeenCalledWith(0, true);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /^Keep Retail Can/ })[0]);
    expect(draft.keep).toHaveBeenCalledWith({ ref: "can", tier: 1, value: 0.58 });
  });

  it("names the customer from the customers the planner was given", () => {
    render(<AlsoUpdatePanel plan={richPlan()} />);
    expect(screen.getAllByText(/Northside, Can/).length).toBeGreaterThan(0);
  });

  it("K3b NIT-3: says the customer list was capped only when the server said truncated", () => {
    const { unmount } = render(<AlsoUpdatePanel plan={richPlan()} />);
    expect(screen.queryByTestId("units-v2-cp-customers-truncated")).toBeNull();
    unmount();
    mockTruncated = true;
    render(<AlsoUpdatePanel plan={richPlan()} />);
    expect(screen.getByTestId("units-v2-cp-customers-truncated")).toHaveTextContent(
      "Showing the first 500 customers with their own prices. Others aren't included.",
    );
  });
});
