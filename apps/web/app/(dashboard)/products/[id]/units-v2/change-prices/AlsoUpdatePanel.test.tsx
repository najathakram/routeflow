import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { AlsoUpdatePanel } from "./AlsoUpdatePanel";
import { EMPTY_SELECTION, offerKey } from "./selection";
import { emptyPlan, richPlan } from "./plan-fixtures";

const noop = () => undefined;
const mount = (over: Partial<React.ComponentProps<typeof AlsoUpdatePanel>> = {}) =>
  render(
    <AlsoUpdatePanel
      plan={richPlan()}
      selection={EMPTY_SELECTION}
      onToggleOffer={noop}
      onToggleKeep={noop}
      {...over}
    />,
  );

describe("AlsoUpdatePanel (V02, SA-799)", () => {
  it("renders every offer unticked, the tier offer and the customer offer both", () => {
    mount();
    const section = screen.getByTestId("also-update-section");
    const boxes = within(section).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    boxes.forEach((b) => expect(b).not.toBeChecked());
    expect(within(section).getByText("Set Tier 3 to $14.60 too")).toBeInTheDocument();
  });

  it("does not pre-select the customer offer even when a customer price moves the other way", () => {
    mount();
    const customer = screen.getByRole("checkbox", { name: /prices set for these customers/i });
    expect(customer).not.toBeChecked();
    expect(
      screen.getAllByTestId("customer-change-row").some((r) => r.dataset.against === "true"),
    ).toBe(true);
  });

  it("asks the caller to tick an offer by its key", () => {
    const onToggleOffer = jest.fn();
    mount({ onToggleOffer });
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3/ }));
    expect(onToggleOffer).toHaveBeenCalledWith(offerKey(richPlan().offers[0]), true);
  });

  it("lists every customer move, grouped, and hides none", () => {
    mount();
    expect(screen.getAllByTestId("customer-change-row")).toHaveLength(4);
    expect(screen.getByTestId("against-summary")).toHaveTextContent("3 prices move the other way");
    const rounding = screen.getByTestId("rounding-group");
    expect(rounding).toHaveTextContent("2 prices move 1 cent from rounding");
    expect(within(rounding).getAllByTestId("customer-change-row")).toHaveLength(2);
  });

  it("gives each follower a Keep that starts off", () => {
    const onToggleKeep = jest.fn();
    mount({ onToggleKeep });
    const keeps = screen.getAllByRole("checkbox", { name: /^Keep /i });
    expect(keeps).toHaveLength(2);
    keeps.forEach((k) => expect(k).not.toBeChecked());
    fireEvent.click(keeps[0]);
    expect(onToggleKeep).toHaveBeenCalledWith(richPlan().followers[0], true);
  });

  it("hides the follower rows when the caller lists them itself, never the customer rows", () => {
    mount({ hideFollowers: true });
    expect(screen.queryByRole("checkbox", { name: /^Keep .*Can/i })).toBeNull();
    expect(screen.getAllByTestId("customer-change-row")).toHaveLength(4);
  });

  it("shows Undo only when asked, and says what Save does", () => {
    const onUndo = jest.fn();
    const { rerender } = mount();
    expect(screen.queryByRole("button", { name: "Undo this change" })).toBeNull();
    rerender(
      <AlsoUpdatePanel
        plan={richPlan()}
        selection={EMPTY_SELECTION}
        onToggleOffer={noop}
        onToggleKeep={noop}
        onUndo={onUndo}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    expect(onUndo).toHaveBeenCalled();
    expect(screen.getByText("Save keeps all of this in one go.")).toBeInTheDocument();
  });

  it("says so when nothing else changes, and shows a refused plan's problem", () => {
    const { rerender } = mount({ plan: emptyPlan() });
    expect(screen.getByText("Nothing else changes.")).toBeInTheDocument();
    rerender(
      <AlsoUpdatePanel
        plan={emptyPlan({ problems: ["Enter an amount above zero."] })}
        selection={EMPTY_SELECTION}
        onToggleOffer={noop}
        onToggleKeep={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount above zero.");
  });
});
