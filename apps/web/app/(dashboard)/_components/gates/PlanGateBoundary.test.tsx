import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { PlanGateBoundary } from "./PlanGateBoundary";
import { isRouteLocked } from "@/lib/plan-gate-lock";
import type { SubscriptionView } from "@/lib/api/billing";

/**
 * B449 (bug-pipeline repro-first): RouteGuard used to render `<LockedPage>{children}</LockedPage>`
 * — LockedPage's ghost/blur treatment only hides the real page visually, it still mounts it, so
 * a locked route fired the gated page's own queries and showed a flash of gated content (plus
 * any inline error) before the lock settled. `PlanGateBoundary` is the extracted, directly
 * testable decision RouteGuard now delegates to.
 *
 * Fix-round finding 2: the boundary now emits the navigation's ONE plan-gate notice itself
 * (naming this route's own gate tier) the moment it decides "locked", instead of relying on
 * whichever gated query happens to 403 first — and marks the pathname locked via
 * `setRouteLocked` so `PlanGateNotice` refuses to let a stray 403 add a second one.
 */

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

const subscription: SubscriptionView = {
  planKey: "LITE",
  planName: "Lite",
  status: "ACTIVE",
  cycle: "MONTHLY",
  monthlyPrice: 99,
  annualPrice: null,
  isCustom: false,
  renewalAt: null,
  cancelAtPeriodEnd: false,
  downgradeToPlanKey: null,
  downgradeEffectiveAt: null,
  trialEndsAt: null,
  addons: [],
  paymentRequired: false,
  flags: [], // LITE grants none of the plan-gated flags
};

function GatedPage({ onMount }: { onMount: () => void }) {
  React.useEffect(() => {
    onMount();
  }, [onMount]);
  return <div data-testid="gated-page-content">Real estimates content</div>;
}

afterEach(() => {
  mockToast.mockClear();
  cleanup();
});

describe("PlanGateBoundary (B449)", () => {
  it("never mounts the gated page while locked — its own query/effect hook never fires", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
        pathname="/estimates"
        subscription={subscription}
        subscriptionResolved
        subscriptionErrored={false}
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gated-page-content")).not.toBeInTheDocument();
    expect(screen.getByText("Not on your plan")).toBeInTheDocument();
  });

  it("never mounts the gated page while the subscription is still resolving (no flash)", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
        pathname="/estimates"
        subscription={undefined}
        subscriptionResolved={false}
        subscriptionErrored={false}
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gated-page-content")).not.toBeInTheDocument();
    // Not the lock either — the answer isn't known yet, so neither surface renders.
    expect(screen.queryByText("Not on your plan")).not.toBeInTheDocument();
    // And no notice fires for an undecided route.
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("mounts the real page once resolved and unlocked", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
        pathname="/estimates"
        subscription={{ ...subscription, flags: ["flag.estimates"] }}
        subscriptionResolved
        subscriptionErrored={false}
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gated-page-content")).toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("fails OPEN on a fetch error — renders the real page rather than stalling on the spinner", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
        pathname="/estimates"
        subscription={undefined}
        subscriptionResolved={false}
        subscriptionErrored
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gated-page-content")).toBeInTheDocument();
  });

  it("renders children immediately for a route that isn't plan-gated", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey={null}
        pathname="/orders"
        subscription={undefined}
        subscriptionResolved={false}
        subscriptionErrored={false}
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gated-page-content")).toBeInTheDocument();
  });

  describe("fix-round finding 2 — the boundary owns the navigation's one notice", () => {
    it("fires exactly one toast naming this route's plan when it decides locked", () => {
      render(
        <PlanGateBoundary
          planGateKey="flag.estimates"
          pathname="/estimates"
          subscription={subscription}
          subscriptionResolved
          subscriptionErrored={false}
        >
          <GatedPage onMount={jest.fn()} />
        </PlanGateBoundary>,
      );

      expect(mockToast).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "This feature isn't included in the Lite plan.",
        }),
      );
    });

    it("marks the pathname locked while rendering the lock, and releases it on unmount", () => {
      const { unmount } = render(
        <PlanGateBoundary
          planGateKey="flag.estimates"
          pathname="/estimates-lock-test"
          subscription={subscription}
          subscriptionResolved
          subscriptionErrored={false}
        >
          <GatedPage onMount={jest.fn()} />
        </PlanGateBoundary>,
      );

      expect(isRouteLocked("/estimates-lock-test")).toBe(true);
      unmount();
      expect(isRouteLocked("/estimates-lock-test")).toBe(false);
    });

    it("does not re-fire the toast on a re-render with the same locked state", () => {
      const { rerender } = render(
        <PlanGateBoundary
          planGateKey="flag.estimates"
          pathname="/estimates"
          subscription={subscription}
          subscriptionResolved
          subscriptionErrored={false}
        >
          <GatedPage onMount={jest.fn()} />
        </PlanGateBoundary>,
      );
      expect(mockToast).toHaveBeenCalledTimes(1);

      // A background refetch that resolves to an equal-but-new subscription object —
      // still locked, same route — must not toast a second time.
      rerender(
        <PlanGateBoundary
          planGateKey="flag.estimates"
          pathname="/estimates"
          subscription={{ ...subscription }}
          subscriptionResolved
          subscriptionErrored={false}
        >
          <GatedPage onMount={jest.fn()} />
        </PlanGateBoundary>,
      );
      expect(mockToast).toHaveBeenCalledTimes(1);
    });

    it("never toasts when unlocked or still resolving", () => {
      render(
        <PlanGateBoundary
          planGateKey="flag.estimates"
          pathname="/estimates"
          subscription={{ ...subscription, flags: ["flag.estimates"] }}
          subscriptionResolved
          subscriptionErrored={false}
        >
          <GatedPage onMount={jest.fn()} />
        </PlanGateBoundary>,
      );
      expect(mockToast).not.toHaveBeenCalled();
    });
  });
});
