import * as React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));

import { PosProgress } from "./PosOrderActions";
import { POS_COPY } from "@/lib/pos-copy";

const steps = () => screen.getAllByRole("listitem");
const inv = [{ id: "i1", status: "SENT" }] as never;

/** W-1043 (SA-1062 MUST 21a) R14a: the third step never reads as handed over before the hand-over. */
describe("PosProgress third step", () => {
  const show = (status: string, fulfillPath?: string) =>
    render(<PosProgress order={{ invoices: inv, fulfillPath } as never} status={status} />);

  it.each([
    ["PENDING", POS_COPY.stepHandedOver],
    ["CONFIRMED", POS_COPY.stepHandedOver],
    ["OUT_FOR_DELIVERY", POS_COPY.readyForPickup],
    ["DELIVERED", POS_COPY.stepHandedOver],
  ])("a PICKUP order at %s reads %s", (status, label) => {
    show(status, "PICKUP");
    expect(steps()[2]).toHaveTextContent(label);
    if (status === "OUT_FOR_DELIVERY")
      expect(steps()[2]).not.toHaveTextContent(POS_COPY.stepHandedOver);
  });

  it("at Ready for pickup the third step is still the highlighted current step, not done", () => {
    show("OUT_FOR_DELIVERY", "PICKUP");
    expect(steps()[2]).toHaveAttribute("aria-current", "step");
    expect(steps()[2]).toHaveAttribute("data-done", "false");
  });

  it("at DELIVERED it is done", () => {
    show("DELIVERED", "PICKUP");
    expect(steps()[2]).toHaveAttribute("data-done", "true");
  });

  it.each(["ROUTE", "SHIP", undefined])("a %s order at OUT_FOR_DELIVERY is unchanged", (path) => {
    show("OUT_FOR_DELIVERY", path);
    expect(steps()[2]).toHaveTextContent(POS_COPY.stepHandedOver);
  });
});
