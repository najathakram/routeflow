import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import BillingSettingsPage from "./page";
import type { SubscriptionView } from "@/lib/api/billing";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Mutable per-test fixture: `useSubscription` reads it dynamically so each `it()` can set its
// own `status`/`readOnlyReason`/`trialEndsAt` without a fresh jest.mock factory per test.
let mockSubscriptionView: SubscriptionView;
const mockCancelMutate = jest.fn();

jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({ data: mockSubscriptionView, isLoading: false, isError: false }),
  useUsage: () => ({ data: [], isLoading: false }),
  usePlans: () => ({ data: { plans: [], addons: [] }, isLoading: false }),
  useCancelSubscription: () => ({ mutate: mockCancelMutate, isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  useEnableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useDisableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
}));

/** Full SubscriptionView with sane ACTIVE defaults — each test overrides only what it needs. */
function subscriptionView(overrides: Partial<SubscriptionView>): SubscriptionView {
  return {
    planKey: "STARTER",
    planName: "Starter",
    status: "ACTIVE",
    cycle: "MONTHLY",
    monthlyPrice: 59,
    annualPrice: null,
    isCustom: false,
    renewalAt: null,
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    ...overrides,
  };
}

describe("BillingSettingsPage — READ_ONLY / TRIAL visibility (RO-1)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("RO-1 a read-only tenant sees the read-only banner with a Choose-a-plan link and no Cancel button", async () => {
    mockSubscriptionView = {
      ...subscriptionView({
        status: "READ_ONLY",
        planKey: "STARTER",
        planName: "Starter",
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
      }),
      // Not yet on SubscriptionView — the DTO/API side of RO-1 adds it.
      readOnlyReason: "trial_expired",
    } as SubscriptionView;

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByText(/workspace is read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/trial ended/i)).toBeInTheDocument();
    const choosePlanLink = screen.getByRole("link", { name: /choose a plan/i });
    expect(choosePlanLink).toHaveAttribute("href", "/choose-plan");
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it("RO-1 a trial tenant sees an End trial action", async () => {
    mockSubscriptionView = subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByRole("button", { name: /end trial/i })).toBeInTheDocument();
  });

  // Regression guard: an ACTIVE tenant keeps today's Cancel affordance. GREEN today.
  it("RO-1 an active tenant still sees Cancel", async () => {
    mockSubscriptionView = subscriptionView({ status: "ACTIVE", cancelAtPeriodEnd: false });

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
  });
});
