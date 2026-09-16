import * as React from "react";
import { render } from "@testing-library/react";
import { PlanGateNotice } from "./PlanGateNotice";
import type { PlanGateBody } from "@/lib/plan-gate";

let capturedListener: ((gate: PlanGateBody) => void) | null = null;

jest.mock("next/navigation", () => ({
  usePathname: () => "/estimates",
}));

jest.mock("@/lib/api-client", () => ({
  registerPlanGateListener: (fn: (gate: PlanGateBody) => void) => {
    capturedListener = fn;
    return () => {
      capturedListener = null;
    };
  },
}));

const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));

const upgrade = { planKey: null, planMonthlyPrice: null, addonSku: null, addonMonthlyPrice: null };

/**
 * B449: a locked route's brief resolving window let its own page mount and fire
 * several gated queries at once — sometimes behind DIFFERENT flags (e.g. the
 * page's own gate plus an embedded widget needing a flag the tenant also
 * lacks) — producing up to three toasts naming contradictory tiers for one
 * navigation. The old dedup keyed on `gate.flag`, so different flags never
 * collapsed. Coalescing by pathname (one navigation) instead fixes that
 * regardless of which flag's query happens to fail first.
 */
describe("PlanGateNotice — B449 dedup by navigation", () => {
  beforeEach(() => {
    toast.mockClear();
    capturedListener = null;
  });

  it("collapses two failed gated queries with DIFFERENT flags on one navigation into ONE notice", () => {
    render(<PlanGateNotice />);
    expect(capturedListener).not.toBeNull();

    capturedListener!({
      code: "PLAN_GATE",
      flag: "flag.analytics",
      message: "This feature isn't included in the Lite plan.",
      upgrade: { ...upgrade, planKey: "GROWTH", planMonthlyPrice: "249" },
    });
    capturedListener!({
      code: "PLAN_GATE",
      flag: "flag.estimates",
      message: "Estimates isn't included in the Lite plan.",
      upgrade: { ...upgrade, planKey: "STARTER", planMonthlyPrice: "99" },
    });

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("still collapses a burst on the SAME flag (pre-existing behaviour, unchanged)", () => {
    render(<PlanGateNotice />);

    for (let i = 0; i < 12; i++) {
      capturedListener!({
        code: "PLAN_GATE",
        flag: "flag.analytics",
        message: "Analytics isn't included in the Lite plan.",
        upgrade: { ...upgrade, planKey: "GROWTH", planMonthlyPrice: "249" },
      });
    }

    expect(toast).toHaveBeenCalledTimes(1);
  });
});
