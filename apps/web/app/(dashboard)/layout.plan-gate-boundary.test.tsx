import * as React from "react";
import { render, screen } from "@testing-library/react";
import { PlanGateBoundary } from "./layout";
import type { SubscriptionView } from "@/lib/api/billing";

/**
 * B449 (bug-pipeline repro-first): RouteGuard used to render `<LockedPage>{children}</LockedPage>`
 * — LockedPage's ghost/blur treatment only hides the real page visually, it still mounts it, so
 * a locked route fired the gated page's own queries and showed a flash of gated content (plus
 * any inline error) before the lock settled. `PlanGateBoundary` is the extracted, directly
 * testable decision RouteGuard now delegates to.
 */

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

describe("PlanGateBoundary (B449)", () => {
  it("never mounts the gated page while locked — its own query/effect hook never fires", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
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
  });

  it("mounts the real page once resolved and unlocked", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
        subscription={{ ...subscription, flags: ["flag.estimates"] }}
        subscriptionResolved
        subscriptionErrored={false}
      >
        <GatedPage onMount={onMount} />
      </PlanGateBoundary>,
    );

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gated-page-content")).toBeInTheDocument();
  });

  it("fails OPEN on a fetch error — renders the real page rather than stalling on the spinner", () => {
    const onMount = jest.fn();
    render(
      <PlanGateBoundary
        planGateKey="flag.estimates"
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
});
