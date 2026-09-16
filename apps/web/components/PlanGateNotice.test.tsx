import * as React from "react";
import { render } from "@testing-library/react";
import { PlanGateNotice } from "./PlanGateNotice";
import { setRouteLocked } from "@/lib/plan-gate-lock";
import type { PlanGateBody } from "@/lib/plan-gate";

let capturedListener: ((gate: PlanGateBody) => void) | null = null;
let mockPathname = "/estimates";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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

const fire = (flag: string, message: string, planKey: string, price: string) =>
  capturedListener!({
    code: "PLAN_GATE",
    flag,
    message,
    upgrade: { ...upgrade, planKey, planMonthlyPrice: price },
  });

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
    mockPathname = "/estimates";
  });

  it("collapses two failed gated queries with DIFFERENT flags on one navigation into ONE notice", () => {
    render(<PlanGateNotice />);
    expect(capturedListener).not.toBeNull();

    fire("flag.analytics", "This feature isn't included in the Lite plan.", "GROWTH", "249");
    fire("flag.estimates", "Estimates isn't included in the Lite plan.", "STARTER", "99");

    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("still collapses a burst on the SAME flag (pre-existing behaviour, unchanged)", () => {
    render(<PlanGateNotice />);

    for (let i = 0; i < 12; i++) {
      fire("flag.analytics", "Analytics isn't included in the Lite plan.", "GROWTH", "249");
    }

    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("PlanGateNotice — fix-round finding 2/5: locked-route suppression + navigation reset", () => {
  beforeEach(() => {
    toast.mockClear();
    capturedListener = null;
    mockPathname = "/estimates";
    setRouteLocked("/estimates", false);
    setRouteLocked("/orders", false);
  });

  it("suppresses a 403-driven toast entirely while PlanGateBoundary has this path locked", () => {
    setRouteLocked("/estimates", true);
    render(<PlanGateNotice />);

    fire("flag.analytics", "This feature isn't included in the Lite plan.", "GROWTH", "249");

    expect(toast).not.toHaveBeenCalled();
    setRouteLocked("/estimates", false);
  });

  it("resumes surfacing 403s once the boundary releases the lock on that path", () => {
    setRouteLocked("/estimates", true);
    render(<PlanGateNotice />);
    fire("flag.analytics", "suppressed while locked", "GROWTH", "249");
    expect(toast).not.toHaveBeenCalled();

    setRouteLocked("/estimates", false);
    fire("flag.analytics", "This feature isn't included in the Lite plan.", "GROWTH", "249");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("resets its dedup memory on navigation — a real pathname change, not a mocked constant", () => {
    const { rerender } = render(<PlanGateNotice />);
    fire("flag.estimates", "Estimates notice", "STARTER", "99");
    expect(toast).toHaveBeenCalledTimes(1);

    // Navigate away, then immediately back — an explicit reset must forget the
    // ORIGINAL path's dedup window rather than let it silently outlive the
    // navigation that produced it.
    mockPathname = "/orders";
    rerender(<PlanGateNotice />);
    mockPathname = "/estimates";
    rerender(<PlanGateNotice />);

    fire("flag.estimates", "Estimates notice", "STARTER", "99");
    expect(toast).toHaveBeenCalledTimes(2);
  });
});
