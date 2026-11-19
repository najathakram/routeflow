import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BillingShellBanner } from "./BillingShellBanner";
import { ReadOnlyBanner } from "./ReadOnlyBanner";

/**
 * REG-B397 (SA-1167 R5): a READ_ONLY tenant status was invisible in the web UI. The wrong value is a
 * READ_ONLY workspace that renders no notice, or one that hides the reason. The dashboard shell's one billing
 * slot (BillingShellBanner) is the mount the layout uses, so it is exercised as well as the banner.
 */
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
}));

const view = (over: Partial<SubscriptionView> = {}): SubscriptionView =>
  ({
    planKey: "TEAM",
    planName: "Team",
    status: "READ_ONLY",
    cycle: "MONTHLY",
    monthlyPrice: 149,
    annualPrice: null,
    isCustom: false,
    renewalAt: null,
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    paymentRequired: false,
    readOnlyReason: "trial_cancelled",
    billingContactEmail: "dana@acme.test",
    ...over,
  }) as SubscriptionView;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("READ_ONLY status is visible in the web UI", () => {
  it("REG-B397: the dashboard shell shows the read-only notice with the reason for a cancelled trial", () => {
    const { container } = renderWithProviders(
      <BillingShellBanner scope="acme" view={view()} userRole="TENANT_ADMIN" />,
    );
    expect(container.textContent).not.toBe("");
    expect(screen.getByText(/read-only mode/)).toBeInTheDocument();
    expect(screen.getByText(/Your subscription was cancelled\./)).toBeInTheDocument();
  });

  it.each([
    ["trial_expired", "Your free trial has ended."],
    ["trial_cancelled", "Your subscription was cancelled."],
    ["subscription_cancelled", "Your subscription was cancelled."],
  ])("REG-B397: ReadOnlyBanner for %s renders the notice and the mapped reason", (reason, line) => {
    const { container } = renderWithProviders(
      <ReadOnlyBanner status="READ_ONLY" readOnlyReason={reason} isAdmin={false} />,
    );
    expect(container.textContent).toContain("read-only mode");
    expect(container.textContent).toContain(line);
  });

  it("REG-B397: a workspace that is not READ_ONLY shows no read-only notice", () => {
    const { container } = renderWithProviders(
      <ReadOnlyBanner status="ACTIVE" readOnlyReason="trial_cancelled" />,
    );
    expect(container.textContent).toBe("");
  });
});
