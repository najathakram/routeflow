import { render, screen, fireEvent } from "@testing-library/react";
import { ChangePrices, useChangePrices } from "./ChangePrices";
import { PLAN_TESTIDS as T } from "./plan-testids";
import { richPlan, VIEW } from "./plan.test-utils";

let mockFlag = true;
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => mockFlag }));
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  planPriceChange: () => richPlan(),
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

/** Stands in for K3's Edit row: the one opener button, wired the way the shell wires it. */
function Harness() {
  const cp = useChangePrices();
  return (
    <>
      {cp.enabled && (
        <button ref={cp.opener} type="button" aria-expanded={cp.open} onClick={cp.toggle}>
          Change prices
        </button>
      )}
      <ChangePrices open={cp.open} onClose={cp.close} openerRef={cp.opener} />
    </>
  );
}

beforeEach(() => {
  mockFlag = true;
  draft.applyPlan.mockReset();
});

describe("ChangePrices (opener + panel)", () => {
  it("renders nothing with the flag off", () => {
    mockFlag = false;
    const { container } = render(<Harness />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the panel from the opener and returns focus to it on Escape (V17)", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Change prices" });
    expect(screen.queryByTestId(T.changePanel)).toBeNull();
    fireEvent.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByTestId(T.changePanel), { key: "Escape" });
    expect(screen.queryByTestId(T.changePanel)).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("reopens empty and unticked after an Apply (no pre-selection)", () => {
    render(<Harness />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Change prices" }));
    open();
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Also raise the prices you set/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(draft.applyPlan).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(T.changePanel)).toBeNull();
    open();
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
    screen.getAllByRole("checkbox").forEach((b) => expect(b).not.toBeChecked());
  });
});
