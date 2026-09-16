import * as React from "react";
import { render, screen } from "@testing-library/react";
import { LockedPage } from "./PlanGates";
import type { PlanGateBody } from "@/lib/plan-gate";

const gate: PlanGateBody = {
  code: "PLAN_GATE",
  flag: "flag.estimates",
  message: "This feature isn't included in the Lite plan.",
  upgrade: { planKey: null, planMonthlyPrice: null, addonSku: null, addonMonthlyPrice: null },
};

describe("LockedPage — secondary prop (Lite-L2 addition)", () => {
  it("renders exactly as before when secondary is omitted (regression pin)", () => {
    render(<LockedPage gate={gate} />);
    expect(screen.getByText("Not on your plan")).toBeInTheDocument();
    expect(screen.getByText(gate.message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /see plans/i })).toBeInTheDocument();
    // No secondary line — the paragraph it would render must not exist at all.
    expect(screen.queryByText(/contact us to upgrade/i)).not.toBeInTheDocument();
  });

  it("renders the secondary line under the CTA when provided", () => {
    render(<LockedPage gate={gate} secondary="Want it? Contact us to upgrade." />);
    expect(screen.getByText("Want it? Contact us to upgrade.")).toBeInTheDocument();
  });
});
