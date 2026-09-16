import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
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
// WP9: mutable per-test fixture for useCreateCheckout, same pattern as mockCancelMutate.
const mockCheckoutMutate = jest.fn();
let mockCheckoutPending = false;

jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({ data: mockSubscriptionView, isLoading: false, isError: false }),
  useUsage: () => ({ data: [], isLoading: false }),
  usePlans: () => ({ data: { plans: [], addons: [] }, isLoading: false }),
  useCancelSubscription: () => ({ mutate: mockCancelMutate, isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  useEnableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useDisableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useCreateCheckout: () => ({ mutate: mockCheckoutMutate, isPending: mockCheckoutPending }),
}));

// Mutable per-test fixture, same pattern as `mockSubscriptionView` above: the real
// `AuthProvider` (mounted by `renderWithProviders`) only ever resolves to a null user in jsdom
// (empty localStorage -> `refreshTokens()` short-circuits with no network call), so W2's
// isAdmin-gated "End trial" control needs a controllable role here instead. Default is
// TENANT_ADMIN so every test that doesn't care about role — including the pre-existing ones
// below — keeps exercising the admin path.
let mockAuthUser: { role: string } | null = { role: "TENANT_ADMIN" };

jest.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    isAuthenticated: mockAuthUser !== null,
    isLoading: false,
    user: mockAuthUser,
    login: jest.fn(),
    logout: jest.fn(),
  }),
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
    flags: [],
    paymentRequired: false,
    ...overrides,
  };
}

describe("BillingSettingsPage — READ_ONLY / TRIAL visibility (RO-1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
  });

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

  // F2: a READ_ONLY tenant with a stale cancelAtPeriodEnd flag must never see the
  // "Cancellation scheduled ... Keep my plan" block — that control calls resume(), which
  // clears the flag but never restores the tenant (a fake resume). The ReadOnlyBanner + its
  // Choose-a-plan CTA is the only control such a tenant should see there.
  it("RO-1 a read-only tenant with cancelAtPeriodEnd never sees the resume control or Cancel", async () => {
    mockSubscriptionView = {
      ...subscriptionView({
        status: "READ_ONLY",
        cancelAtPeriodEnd: true,
      }),
      readOnlyReason: "trial_cancelled",
    } as SubscriptionView;

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByText(/workspace is read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /keep my plan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/cancellation scheduled/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  // F8: "End trial" calls a TENANT_ADMIN-only endpoint; gate it on the same admin predicate
  // the rest of settings uses (`user.role === "TENANT_ADMIN"`) so it isn't a dead 403 control.
  it("RO-1 a trial tenant (admin) confirms End trial and calls cancel exactly once", async () => {
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockSubscriptionView = subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "End trial" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "End trial" })).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "End trial" }));

    expect(mockCancelMutate).toHaveBeenCalledTimes(1);
    expect(mockCancelMutate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("RO-1 a trial tenant as OPERATOR sees no End trial control and no read-only banner", async () => {
    mockAuthUser = { role: "OPERATOR" };
    mockSubscriptionView = subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByRole("button", { name: /change plan/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /end trial/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/workspace is read-only/i)).not.toBeInTheDocument();
  });
});

describe("BillingSettingsPage — Complete payment (WP9, R2.5/R2.8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockCheckoutPending = false;
  });

  it("paymentRequired renders the price line and a Complete payment button", async () => {
    mockSubscriptionView = subscriptionView({
      planKey: "LITE",
      planName: "Lite",
      status: "READ_ONLY",
      monthlyPrice: 99,
      paymentRequired: true,
    });

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByText("Lite · $99/mo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete payment" })).toBeInTheDocument();
  });

  it("clicking Complete payment calls the checkout mutation exactly once", async () => {
    mockSubscriptionView = subscriptionView({
      planKey: "LITE",
      planName: "Lite",
      status: "READ_ONLY",
      monthlyPrice: 99,
      paymentRequired: true,
    });
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Complete payment" }));

    expect(mockCheckoutMutate).toHaveBeenCalledTimes(1);
  });

  it("Complete payment shows a loading state while the mutation is in flight", async () => {
    mockSubscriptionView = subscriptionView({
      planKey: "LITE",
      planName: "Lite",
      status: "READ_ONLY",
      monthlyPrice: 99,
      paymentRequired: true,
    });
    mockCheckoutPending = true;

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByRole("button", { name: "Complete payment" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("an ACTIVE tenant (paymentRequired false) never sees Complete payment or the price line", async () => {
    mockSubscriptionView = subscriptionView({
      planKey: "STARTER",
      planName: "Starter",
      status: "ACTIVE",
      monthlyPrice: 59,
      paymentRequired: false,
    });

    renderWithProviders(<BillingSettingsPage />);

    await screen.findByRole("button", { name: /change plan/i });
    expect(screen.queryByRole("button", { name: "Complete payment" })).not.toBeInTheDocument();
    expect(screen.queryByText("Starter · $59/mo")).not.toBeInTheDocument();
  });
});
