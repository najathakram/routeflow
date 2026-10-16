import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { planPriceChange } from "@routeflow/pricing";
import { ChangePricesPanel } from "./ChangePricesPanel";
import { emptyPlan, longPlan, richPlan, VIEW } from "./plan-fixtures";

jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  planPriceChange: jest.fn(),
}));
let mockFlag = true;
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => mockFlag }));
const mockSave = jest.fn();
jest.mock("./usePricePlanSave", () => ({
  usePricePlanSave: () => ({ save: mockSave, isPending: false }),
}));

const plan = planPriceChange as jest.Mock;
const mount = (over: Partial<React.ComponentProps<typeof ChangePricesPanel>> = {}) =>
  render(<ChangePricesPanel open onOpenChange={jest.fn()} view={VIEW} {...over} />);
const type = (v: string) =>
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: v } });

beforeEach(() => {
  mockFlag = true;
  mockSave.mockReset().mockResolvedValue(undefined);
  plan.mockReset().mockReturnValue(richPlan());
});

describe("ChangePricesPanel (V03, V05, V18)", () => {
  it("renders nothing with the flag off, or closed", () => {
    mockFlag = false;
    const { container, rerender } = mount();
    expect(container).toBeEmptyDOMElement();
    mockFlag = true;
    rerender(<ChangePricesPanel open={false} onOpenChange={jest.fn()} view={VIEW} />);
    expect(container).toBeEmptyDOMElement();
  });

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
    mount({ customers: [{ customerId: "c1", tier: 1 }] });
    expect(plan).not.toHaveBeenCalled();
    type("5");
    expect(plan).toHaveBeenLastCalledWith(
      VIEW,
      { unit: "case", direction: "raise", mode: "percent", value: 5, also: false },
      undefined,
      undefined,
      { customers: [{ customerId: "c1", tier: 1 }] },
    );
    expect(screen.getByTestId("change-prices-preview")).toHaveTextContent("$14.60");
    expect(screen.getByTestId("change-prices-preview")).toHaveTextContent("$13.91");
  });

  it("passes also: true only after the owner ticks the prices they set", () => {
    mount();
    type("5");
    const also = screen.getByRole("checkbox", { name: /Also raise the prices you set/ });
    expect(also).not.toBeChecked();
    fireEvent.click(also);
    expect(plan).toHaveBeenLastCalledWith(
      VIEW,
      expect.objectContaining({ also: true }),
      undefined,
      undefined,
      expect.anything(),
    );
  });

  it("never pre-selects the customer opt-in, and lists every customer move grouped", () => {
    mount();
    type("5");
    expect(
      screen.getByRole("checkbox", { name: /prices set for these customers/i }),
    ).not.toBeChecked();
    expect(screen.getAllByTestId("customer-change-row")).toHaveLength(4);
    expect(screen.getByTestId("against-summary")).toBeInTheDocument();
  });

  it("keeps Apply in the DOM inside the sticky footer while the preview is long", () => {
    plan.mockReturnValue(longPlan(40));
    mount();
    type("5");
    expect(
      within(screen.getByTestId("change-prices-preview")).getAllByRole("row").length,
    ).toBeGreaterThan(40);
    const footer = screen.getByTestId("change-prices-footer");
    expect(footer.className).toContain("sticky");
    expect(footer.className).toContain("bottom-0");
    expect(within(footer).getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("disables Apply and does not plan until an amount is typed", () => {
    mount();
    expect(plan).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("disables Apply and shows the problem when the plan is refused", () => {
    plan.mockReturnValue(emptyPlan({ problems: ["Enter an amount above zero."] }));
    mount();
    type("0");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount above zero.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("hands the plan and only the ticked offers to the save hook", async () => {
    const onApplied = jest.fn();
    mount({ onApplied });
    type("5");
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3 to \$14.60 too/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByTestId("change-prices-footer");
    expect(mockSave).toHaveBeenCalledTimes(1);
    const write = mockSave.mock.calls[0][0];
    expect(write.plan).toEqual(richPlan());
    expect(write.patches).toEqual([
      { ref: "case", tier: 1, to: 14.6 },
      { ref: "case", tier: 3, to: 14.6 },
    ]);
    expect(write.customerMoves).toEqual([]);
    expect(onApplied).toHaveBeenCalled();
  });

  it("uses the draft callback instead of the save hook when one is given", () => {
    const onApply = jest.fn();
    mount({ onApply });
    type("5");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("closes on Cancel and on Escape", () => {
    const onOpenChange = jest.fn();
    mount({ onOpenChange });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByTestId("change-prices-panel"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
