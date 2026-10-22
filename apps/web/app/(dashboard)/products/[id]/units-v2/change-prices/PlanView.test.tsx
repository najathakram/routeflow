import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { PLAN_TESTIDS as T } from "./plan-testids";
import { customerChange, emptyPlan, richPlan } from "./plan.test-utils";
import { EMPTY_SELECTION } from "./selection";

const noop = () => undefined;
const tierName = (t: number) => (t === 1 ? "Retail" : `Tier ${t}`);
const mount = (over: Partial<React.ComponentProps<typeof PlanView>> = {}) =>
  render(
    <PlanView
      plan={richPlan()}
      selection={EMPTY_SELECTION}
      onToggleOffer={noop}
      onToggleKeep={noop}
      tierName={tierName}
      customerName={() => "A customer"}
      {...over}
    />,
  );

describe("PlanView (V02, SA-799)", () => {
  it("renders every offer unticked, the tier offer and the customer offer both", () => {
    mount();
    const boxes = within(screen.getByTestId(T.alsoUpdate)).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    boxes.forEach((b) => expect(b).not.toBeChecked());
    expect(screen.getByText("Set Tier 3 to $14.60 too")).toBeInTheDocument();
  });

  it("does not pre-select the customer offer even when a customer price moves the other way", () => {
    mount();
    expect(
      screen.getByRole("checkbox", { name: /prices set for these customers/i }),
    ).not.toBeChecked();
    expect(screen.getAllByTestId(T.customerRow).some((r) => r.dataset.against === "true")).toBe(
      true,
    );
  });

  it("says the customer offer is off by default and keeps its set prices", () => {
    mount();
    expect(
      screen.getByText("Off by default. Their set prices stay as they are unless you tick this."),
    ).toBeInTheDocument();
  });

  it("asks the caller to tick an offer by its index", () => {
    const onToggleOffer = jest.fn();
    mount({ onToggleOffer });
    fireEvent.click(screen.getByRole("checkbox", { name: /Set Tier 3/ }));
    expect(onToggleOffer).toHaveBeenCalledWith(0, true);
  });

  it("shows an offer as ticked only when the selection says so", () => {
    mount({ selection: { ...EMPTY_SELECTION, ticked: [false, true] } });
    expect(screen.getByRole("checkbox", { name: /prices set for these customers/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Set Tier 3/ })).not.toBeChecked();
  });

  it("lists every customer move, grouped, and hides none", () => {
    mount();
    expect(screen.getAllByTestId(T.customerRow)).toHaveLength(4);
    expect(screen.getByTestId(T.againstSummary)).toHaveTextContent("3 prices move the other way");
    const rounding = screen.getByTestId(T.roundingGroup);
    expect(rounding).toHaveTextContent("2 prices move 1 cent from rounding");
    expect(within(rounding).getAllByTestId(T.customerRow)).toHaveLength(2);
  });

  it("says '1 price moves' for a single rounding row", () => {
    mount({
      plan: emptyPlan({
        customerChanges: [customerChange(1, { against: true, cause: "rounding", to: 1.12 })],
      }),
    });
    expect(screen.getByTestId(T.roundingGroup)).toHaveTextContent(
      "1 price moves 1 cent from rounding",
    );
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
    expect(screen.queryByTestId(T.followerRow)).toBeNull();
    expect(screen.getAllByTestId(T.customerRow)).toHaveLength(4);
  });

  it("says so when nothing else changes, and shows a refused plan's problem", () => {
    const { rerender } = mount({ plan: emptyPlan() });
    expect(screen.getByText("Nothing else changes.")).toBeInTheDocument();
    rerender(
      <PlanView
        plan={emptyPlan({ problems: ["Enter an amount above zero."] })}
        selection={EMPTY_SELECTION}
        onToggleOffer={noop}
        onToggleKeep={noop}
        tierName={tierName}
        customerName={() => "A customer"}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an amount above zero.");
  });
});

describe("K3b NIT-3: a capped customer list says so", () => {
  const NOTE = "Showing the first 500 customers with their own prices. Others aren't included.";
  it("shows one short note in the Also update section when the customers were truncated", () => {
    mount({ customersTruncated: true });
    const note = screen.getByTestId(T.customersTruncated);
    expect(note).toHaveTextContent(NOTE);
    expect(screen.getByTestId(T.alsoUpdate)).toContainElement(note);
    expect(screen.getAllByTestId(T.customersTruncated)).toHaveLength(1);
  });

  it.each([[false], [undefined]])("shows no note when truncated is %p", (customersTruncated) => {
    mount({ customersTruncated });
    expect(screen.queryByTestId(T.customersTruncated)).toBeNull();
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("has no Also update section to put it in when nothing is on offer, so it shows nothing", () => {
    mount({ plan: emptyPlan(), customersTruncated: true });
    expect(screen.queryByTestId(T.customersTruncated)).toBeNull();
  });
});

describe("K12 P16: no 'ALSO UPDATE:' eyebrow over an 'Also ...' offer", () => {
  it("the section label is not drawn (screen readers still get the group name)", () => {
    mount();
    const label = within(screen.getByTestId(T.alsoUpdate)).getByText("Also update:");
    expect(label.className.split(/\s+/)).toContain("sr-only");
  });
});
