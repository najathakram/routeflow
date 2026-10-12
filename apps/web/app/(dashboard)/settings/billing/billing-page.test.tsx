import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import userEvent from "@testing-library/user-event";
import { API_ERROR_CODES } from "@routeflow/types";
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
const mockPortalMutate = jest.fn();
let mockCheckoutPending = false;
// Add-on fixtures: the catalog the page lists, and the mutations/preview the confirm sheet drives.
const mockEnableMutate = jest.fn();
const mockDisableMutate = jest.fn();
let mockPlansAddons: Array<Record<string, unknown>> = [];
let mockProrationPreview: {
  data?: Record<string, unknown>;
  isLoading: boolean;
  isFetching?: boolean;
  isError: boolean;
} = { isLoading: false, isFetching: false, isError: false };

jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({ data: mockSubscriptionView, isLoading: false, isError: false }),
  useUsage: () => ({ data: [], isLoading: false }),
  usePlans: () => ({ data: { plans: [], addons: mockPlansAddons }, isLoading: false }),
  useCancelSubscription: () => ({ mutate: mockCancelMutate, isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  useEnableAddon: () => ({ mutate: mockEnableMutate, isPending: false, variables: undefined }),
  useDisableAddon: () => ({ mutate: mockDisableMutate, isPending: false, variables: undefined }),
  useProrationPreview: (sku: string | null) =>
    sku
      ? mockProrationPreview
      : { data: undefined, isLoading: false, isFetching: false, isError: false },
  useCreateCheckout: () => ({ mutate: mockCheckoutMutate, isPending: mockCheckoutPending }),
  useBillingPortal: () => ({ mutate: mockPortalMutate, isPending: false }),
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

    expect(
      await screen.findByText(/workspace is currently in read-only mode/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/free trial has ended/i)).toBeInTheDocument();
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

    expect(
      await screen.findByText(/workspace is currently in read-only mode/i),
    ).toBeInTheDocument();
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

  // SA-775 follow-up: while auto-locks are paused a production tenant may stay writable, so the copy must
  // not promise an immediate lock; it is true both when the pause holds the lock and when it does not.
  it("RO-1 the End trial dialog does not promise an immediate read-only lock", async () => {
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockSubscriptionView = subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "End trial" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      dialog.getByText("Your workspace becomes read-only; exports still work."),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/immediately/i)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/workspace is currently in read-only mode/i)).not.toBeInTheDocument();
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

  it("an OPERATOR sees the price line but no Complete payment button, and a read-only note", async () => {
    mockAuthUser = { role: "OPERATOR" };
    mockSubscriptionView = subscriptionView({
      planKey: "LITE",
      planName: "Lite",
      status: "READ_ONLY",
      monthlyPrice: 99,
      paymentRequired: true,
    });

    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByText("Lite · $99/mo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete payment" })).toBeNull();
    expect(screen.getByText("Only a workspace admin can complete payment.")).toBeVisible();
    expect(mockCheckoutMutate).not.toHaveBeenCalled();
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

// ─── Money confirmations: nothing is charged / cancelled before an explicit confirm ─────────────

const ADDON = {
  sku: "ROUTE_PLUS",
  name: "Route Plus",
  monthlyPrice: 49,
  unit: "tenant",
  includedAtPlan: null,
  meteredKey: null,
  capacityPerUnit: null,
  stackable: false,
  grantsFlags: [],
  sortOrder: 1,
};

describe("BillingSettingsPage — add-on and cancel confirmations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockPlansAddons = [ADDON];
    mockProrationPreview = {
      data: {
        sku: "ROUTE_PLUS",
        name: "Route Plus",
        monthly: 49,
        proratedToday: 24.5,
        daysRemaining: 15,
        daysInCycle: 30,
        effectiveAt: "2026-10-02T00:00:00.000Z",
        nextChargeAt: "2026-10-17T00:00:00.000Z",
        billing: "STRIPE",
        billed: true,
      },
      isLoading: false,
      isFetching: false,
      isError: false,
    };
    mockSubscriptionView = subscriptionView({ status: "ACTIVE", cancelAtPeriodEnd: false });
    mockEnableMutate.mockReset();
  });

  it("Enable opens a confirm sheet with the add-on name and the prorated charge, and does NOT enable yet", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));

    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("Enable Route Plus?")).toBeInTheDocument();
    expect(dialog.getByText("Route Plus")).toBeInTheDocument();
    expect(dialog.getByText("About $24.50 this cycle")).toBeInTheDocument();
    expect(mockEnableMutate).not.toHaveBeenCalled();
  });

  it("confirming the sheet enables the add-on exactly once, with its sku", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));

    expect(mockEnableMutate).toHaveBeenCalledTimes(1);
    expect(mockEnableMutate).toHaveBeenCalledWith(
      { sku: "ROUTE_PLUS" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("dismissing the enable sheet never enables the add-on", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));

    expect(mockEnableMutate).not.toHaveBeenCalled();
  });

  it("the enable sheet cannot be confirmed until the prorated charge has loaded", async () => {
    mockProrationPreview = { data: undefined, isLoading: true, isFetching: true, isError: false };
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(mockEnableMutate).not.toHaveBeenCalled();
  });

  it("a cached preview that is being re-fetched cannot be confirmed and its amount is not shown", async () => {
    // isLoading is false whenever there is cached data; only isFetching says the figure is stale.
    mockProrationPreview = {
      ...mockProrationPreview,
      data: { ...mockProrationPreview.data, proratedToday: 24.5 },
      isLoading: false,
      isFetching: true,
      isError: false,
    };
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.queryByText("$24.50")).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(mockEnableMutate).not.toHaveBeenCalled();
  });

  it("the enable sheet stays blocked, with fixed copy, when the charge preview fails", async () => {
    mockProrationPreview = { data: undefined, isLoading: false, isError: true };
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByText(/couldn.t work out the cost/i)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
  });

  it("Disable asks for confirmation before disabling", async () => {
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [{ sku: "ROUTE_PLUS", name: "Route Plus", monthly: 49 }] as never,
    });
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(mockDisableMutate).not.toHaveBeenCalled();

    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Disable add-on" }));
    expect(mockDisableMutate).toHaveBeenCalledTimes(1);
    expect(mockDisableMutate).toHaveBeenCalledWith(
      { sku: "ROUTE_PLUS" },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  // ── The sheet follows the REAL billing (preview.billing from #3129: STRIPE | MANUAL | UNBILLED) ──

  const withPreview = (over: Record<string, unknown>) => {
    mockProrationPreview = {
      ...mockProrationPreview,
      data: { ...mockProrationPreview.data, ...over },
    };
  };
  const openEnableSheet = async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Enable" }));
    return { user, dialog: within(await screen.findByRole("dialog")) };
  };

  it("the Enable sheet fits a 390px screen: 44px footer buttons and 16px side gutters (sm and up unchanged)", async () => {
    const { dialog } = await openEnableSheet();
    for (const name of ["Cancel", "Enable add-on"]) {
      const cls = dialog.getByRole("button", { name }).className;
      expect(cls).toMatch(/(^|\s)min-h-11(\s|$)/);
      expect(cls).toMatch(/(^|\s)sm:min-h-0(\s|$)/);
    }
    const sheet = screen.getByRole("dialog").className;
    expect(sheet).toContain("max-w-[calc(100vw-2rem)]");
    expect(sheet).toContain("sm:max-w-sm");
    expect(sheet).not.toMatch(/(^|\s)max-w-sm(\s|$)/);
  });

  it("STRIPE: labels the figure an ESTIMATE ('About $24.50 this cycle'), never a charge", async () => {
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText("About $24.50 this cycle")).toBeInTheDocument();
    expect(dialog.getByText(/added to your next bill/i)).toBeInTheDocument();
    expect(dialog.queryByText(/charged as soon as|charged today|Prorated this cycle/i)).toBeNull();
  });

  it("STRIPE: after confirming, the success toast shows STRIPE's actual prorated figure", async () => {
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: 6.37, billing: "STRIPE" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(await screen.findByText("Prorated $6.37 this cycle.")).toBeInTheDocument();
    expect(screen.queryByText(/24\.50/)).toBeNull(); // never the estimate
  });

  it("STRIPE: when Stripe's figure could not be read the toast says it will show on the next bill", async () => {
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: null, billing: "STRIPE" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await screen.findByText("The prorated amount will show on your next bill."),
    ).toBeInTheDocument();
  });

  it("MANUAL: 'Added to your plan. It will appear on your next invoice from us.' and NO card wording", async () => {
    withPreview({ billing: "MANUAL", billed: true });
    const { dialog } = await openEnableSheet();
    expect(
      dialog.getByText("Added to your plan. It will appear on your next invoice from us."),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/card|prorated|about \$|per cycle|this cycle/i)).toBeNull();
    expect(dialog.queryByText("$24.50")).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled();
  });

  it("MANUAL: the success toast repeats the invoice wording", async () => {
    withPreview({ billing: "MANUAL", billed: true });
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: null, billing: "MANUAL" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await screen.findByText("It will appear on your next invoice from us."),
    ).toBeInTheDocument();
  });

  // SA-690: UNBILLED is worded by the tenant's status. A TRIAL tenant is free until the trial ends
  // and the fresh preview's own monthly figure is the price after; an ACTIVE tenant with no Stripe
  // subscription gets neutral copy. The word "pilot" never reaches the tenant.
  const trialSubscription = () =>
    subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
  const NOT_BILLED_COPY = "Not billed online yet; your account manager will set up billing.";

  it("TRIAL + UNBILLED: 'Free during your trial, then $55.00/mo' from the fresh preview, not the catalog", async () => {
    mockSubscriptionView = trialSubscription();
    mockPlansAddons = [{ ...ADDON, monthlyPrice: 50 }];
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, monthly: 55 });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText("Free during your trial, then $55.00/mo")).toBeInTheDocument();
    expect(dialog.queryByText(/\$50\.00|\$24\.50|invoice/i)).toBeNull();
    expect(dialog.queryByText(NOT_BILLED_COPY)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled();
  });

  // SA-690 option A: a trial's add-on is billed at the card checkout, so the sheet says WHEN it starts
  // costing money (the first paid month, once a card is added) and never advises turning it off.
  const TRIAL_BILLED_LINE = "It is billed from your first paid month, once you add your card.";
  // The retired interim gate's line: the checkout no longer refuses, so no sheet may say this.
  const CHECKOUT_GATE_LINE =
    "Turn it off before adding your card, or contact support to set it up.";

  it("TRIAL (preview.trial true) + UNBILLED: billed from the first paid month once a card is added, with NO advice to turn it off", async () => {
    mockSubscriptionView = trialSubscription();
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, trial: true });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText("Free during your trial, then $49.00/mo")).toBeInTheDocument();
    expect(dialog.getByText(TRIAL_BILLED_LINE)).toBeInTheDocument();
    expect(dialog.queryByText(CHECKOUT_GATE_LINE)).toBeNull();
    expect(dialog.queryByText(/turn it off|contact support|before adding your card/i)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled();
  });

  it("the PREVIEW's trial flag decides the wording: trial true on a non-TRIAL subscription still reads the trial copy", async () => {
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, trial: true });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(TRIAL_BILLED_LINE)).toBeInTheDocument();
    expect(dialog.queryByText(NOT_BILLED_COPY)).toBeNull();
  });

  it("an API without the preview flag falls back to the subscription status (TRIAL still reads the trial copy)", async () => {
    mockSubscriptionView = trialSubscription();
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(TRIAL_BILLED_LINE)).toBeInTheDocument();
    expect(dialog.queryByText(CHECKOUT_GATE_LINE)).toBeNull();
  });

  it("NON-trial (preview.trial false) + UNBILLED: the neutral copy only — no trial wording, no gate line", async () => {
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, trial: false });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(NOT_BILLED_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(TRIAL_BILLED_LINE)).toBeNull();
    expect(dialog.queryByText(CHECKOUT_GATE_LINE)).toBeNull();
    expect(dialog.queryByText(/free during your trial/i)).toBeNull();
  });

  it("the preview's trial flag wins over the subscription status (trial false on a TRIAL view reads neutral)", async () => {
    mockSubscriptionView = trialSubscription();
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, trial: false });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(NOT_BILLED_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(TRIAL_BILLED_LINE)).toBeNull();
  });

  it("ACTIVE + UNBILLED never shows the card-gate line", async () => {
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null });
    const first = await openEnableSheet();
    expect(first.dialog.queryByText(CHECKOUT_GATE_LINE)).toBeNull();
  });

  it("TRIAL + REFUSED (a BLOCKED sheet) never shows the card-gate line", async () => {
    mockSubscriptionView = trialSubscription();
    withPreview(refused(API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN));
    const { dialog } = await openEnableSheet();
    expect(dialog.queryByText(CHECKOUT_GATE_LINE)).toBeNull();
  });

  it("ACTIVE + UNBILLED (no Stripe subscription): neutral 'Not billed online yet' copy and no amount", async () => {
    withPreview({ billing: "UNBILLED", billed: false, proratedToday: null, monthly: 55 });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(NOT_BILLED_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(/\$\d|free during your trial|no charge|card|invoice/i)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled();
  });

  it("UNBILLED on a TRIAL: the success toast says it is free during the trial", async () => {
    mockSubscriptionView = trialSubscription();
    withPreview({ billing: "UNBILLED", billed: false });
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: 0, billing: "UNBILLED" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(await screen.findByText("Free during your trial, then $49.00/mo.")).toBeInTheDocument();
  });

  it("UNBILLED on a TRIAL: the toast quotes the fresh preview monthly the sheet showed, not the catalog", async () => {
    mockSubscriptionView = trialSubscription();
    mockPlansAddons = [{ ...ADDON, monthlyPrice: 50 }];
    withPreview({ billing: "UNBILLED", billed: false, monthly: 55 });
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: 0, billing: "UNBILLED" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(await screen.findByText("Free during your trial, then $55.00/mo.")).toBeInTheDocument();
    expect(screen.queryByText(/50\.00/)).toBeNull();
  });

  it("UNBILLED on an ACTIVE tenant: the success toast uses the neutral copy", async () => {
    withPreview({ billing: "UNBILLED", billed: false });
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onSuccess?.({ proratedNow: 0, billing: "UNBILLED" }),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(await screen.findByText(NOT_BILLED_COPY)).toBeInTheDocument();
  });

  it('the word "pilot" is never rendered, in any billing mode, or left in the billing sources', async () => {
    for (const billing of ["STRIPE", "MANUAL", "UNBILLED"]) {
      withPreview({ billing, billed: billing !== "UNBILLED" });
      const { unmount } = renderWithProviders(<BillingSettingsPage />);
      await userEvent.setup().click(await screen.findByRole("button", { name: "Enable" }));
      await screen.findByRole("dialog");
      expect(document.body.textContent ?? "").not.toMatch(/pilot/i);
      unmount();
    }
    for (const rel of ["page.tsx", "../../../../lib/api/billing.ts"]) {
      expect(fs.readFileSync(path.resolve(__dirname, rel), "utf8")).not.toMatch(/pilot/i);
    }
  });

  // ── (c) the sheet quotes the FRESH preview's monthly figure, never the cached catalog price ──

  it("STRIPE: the sheet quotes the fresh preview monthly ($55.00), not the cached catalog price ($50.00)", async () => {
    mockPlansAddons = [{ ...ADDON, monthlyPrice: 50 }];
    withPreview({ monthly: 55 });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText("$55.00/mo")).toBeInTheDocument();
    expect(dialog.getByText(/then \$55\.00\/mo/)).toBeInTheDocument();
    expect(dialog.queryByText(/50\.00/)).toBeNull();
  });

  it("ANNUAL Stripe plan: shows the fixed contact-support copy and Confirm is disabled", async () => {
    mockSubscriptionView = subscriptionView({ status: "ACTIVE", cycle: "ANNUAL" });
    const { dialog } = await openEnableSheet();
    expect(
      dialog.getByText(
        "Add-ons can't be added to an annual plan online yet. Please contact support.",
      ),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.queryByText(/About \$/)).toBeNull();
  });

  it("a server refusal (ADDON_ANNUAL_NOT_SUPPORTED) keeps the sheet open with the same fixed copy and blocks Confirm", async () => {
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(
        Object.assign(new Error("Request failed"), {
          response: {
            status: 409,
            data: {
              code: API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED,
              message: "internal detail Stripe",
            },
          },
        }),
      ),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await dialog.findByText(
        "Add-ons can't be added to an annual plan online yet. Please contact support.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
  });

  // ── SA-669a M1: a REFUSED preview is a BLOCKED sheet — no price, no charge, Confirm disabled ──

  const INCLUDED_COPY = "Route Plus is already included in your plan.";
  const ANNUAL_COPY =
    "Add-ons can't be added to an annual plan online yet. Please contact support.";
  const refused = (code: string) => ({
    billing: "REFUSED",
    billed: false,
    proratedToday: null,
    refusal: { code, message: "server text that must never be shown" },
  });

  it("REFUSED (ADDON_INCLUDED_IN_PLAN) on a monthly plan: Confirm disabled, included copy, no price or charge line", async () => {
    withPreview(refused(API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN));
    const { dialog } = await openEnableSheet();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.getByText(INCLUDED_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(/\$[\d.,]+\s*\/mo/)).toBeNull();
    expect(dialog.queryByText(/About \$|this cycle|next bill|invoice|no charge/i)).toBeNull();
    expect(screen.queryByText(/server text that must never be shown/)).toBeNull();
  });

  it("REFUSED (ADDON_ANNUAL_NOT_SUPPORTED) on an annual plan: Confirm disabled, annual copy, no price or charge line", async () => {
    mockSubscriptionView = subscriptionView({ status: "ACTIVE", cycle: "ANNUAL" });
    withPreview(refused(API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED));
    const { dialog } = await openEnableSheet();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.getByText(ANNUAL_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(/\$[\d.,]+\s*\/mo/)).toBeNull();
    expect(dialog.queryByText(/About \$|this cycle|next bill|invoice|no charge/i)).toBeNull();
  });

  it("REFUSED with a refusal object and no billing field is still BLOCKED", async () => {
    withPreview({ ...refused(API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN), billing: undefined });
    const { dialog } = await openEnableSheet();
    expect(dialog.getByText(INCLUDED_COPY)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
  });

  it("REFUSED with a code this page does not know gets fixed generic copy and Confirm stays disabled", async () => {
    withPreview(refused("SOMETHING_NEW"));
    const { dialog } = await openEnableSheet();
    expect(
      dialog.getByText("This add-on can't be turned on online right now. Please contact support."),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.queryByText(/\$[\d.,]+\s*\/mo/)).toBeNull();
  });

  // ── SA-669a M2: the enable error keys on response.data.code, never on the HTTP status ──

  const rejectEnableWith = (status: number, data: Record<string, unknown>) =>
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(Object.assign(new Error("Request failed"), { response: { status, data } })),
    );

  it("an enable rejected with 409 {code: ADDON_INCLUDED_IN_PLAN} shows the included copy and blocks Confirm", async () => {
    rejectEnableWith(409, {
      code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
      message: "internal detail",
    });
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(await dialog.findByText(INCLUDED_COPY)).toBeInTheDocument();
    expect(dialog.queryByText(ANNUAL_COPY)).toBeNull();
    expect(screen.queryByText(/internal detail/)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
  });

  it("a 409 whose body carries no known code BLOCKS the sheet with generic copy, not the annual copy", async () => {
    rejectEnableWith(409, { message: "some other conflict" });
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await dialog.findByText(
        "This add-on can't be turned on online right now. Please contact support.",
      ),
    ).toBeInTheDocument();
    expect(dialog.queryByText(ANNUAL_COPY)).toBeNull();
    expect(screen.queryByText(/some other conflict/)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
    expect(dialog.queryByText(/\$[\d.,]+\s*\/mo/)).toBeNull();
  });

  it("a 409 with an unrecognised code is BLOCKED too, never keyed on the status alone", async () => {
    rejectEnableWith(409, { code: "SOMETHING_NEW", message: "x" });
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await dialog.findByText(
        "This add-on can't be turned on online right now. Please contact support.",
      ),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeDisabled();
  });

  it("any other failure keeps the sheet open with fixed 'didn't go through' copy and allows a retry", async () => {
    mockEnableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(
        Object.assign(new Error("Request failed"), {
          response: { status: 503, data: { message: "api_connection_error sk_live" } },
        }),
      ),
    );
    const { user, dialog } = await openEnableSheet();
    await user.click(dialog.getByRole("button", { name: "Enable add-on" }));
    expect(
      await dialog.findByText(
        "We couldn't turn this add-on on. Nothing was changed. Please try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sk_live|api_connection/)).toBeNull();
    expect(dialog.getByRole("button", { name: "Enable add-on" })).toBeEnabled();
  });

  it("Cancel subscription asks for confirmation and does not cancel until confirmed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    expect(mockCancelMutate).not.toHaveBeenCalled();

    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel subscription" }));
    expect(mockCancelMutate).toHaveBeenCalledTimes(1);
  });

  it("dismissing the cancel confirm never cancels the subscription", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Keep my plan" }));

    expect(mockCancelMutate).not.toHaveBeenCalled();
  });

  it("Cancel subscription that fails shows fixed failure copy, never the server's text", async () => {
    mockCancelMutate.mockReset();
    mockCancelMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(
        Object.assign(new Error("Request failed"), {
          response: { status: 500, data: { message: "stripe internal sk_live_detail" } },
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel subscription" }));

    expect(
      await screen.findByText("We couldn't cancel your subscription. Nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sk_live_detail/)).toBeNull();
  });

  it("Disable that fails shows fixed failure copy, never the server's text", async () => {
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [{ sku: "ROUTE_PLUS", name: "Route Plus", monthly: 49 }] as never,
    });
    mockDisableMutate.mockReset();
    mockDisableMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(
        Object.assign(new Error("Request failed"), {
          response: { status: 500, data: { message: "stripe internal sk_live_detail" } },
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Disable" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Disable add-on" }));

    expect(
      await screen.findByText("We couldn't turn this add-on off. Nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Route Plus not disabled")).toBeInTheDocument();
    expect(screen.queryByText(/sk_live_detail/)).toBeNull();
    expect(screen.queryByText("History kept read-only.")).toBeNull();
  });

  it("End trial that fails shows fixed failure copy, never the server's text", async () => {
    mockSubscriptionView = subscriptionView({
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    mockCancelMutate.mockReset();
    mockCancelMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(
        Object.assign(new Error("Request failed"), {
          response: { status: 500, data: { message: "stripe internal sk_live_detail" } },
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);

    await user.click(await screen.findByRole("button", { name: /end trial/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "End trial" }));

    expect(
      await screen.findByText("We couldn't end your trial. Nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Trial not ended")).toBeInTheDocument();
    expect(screen.queryByText(/sk_live_detail/)).toBeNull();
    expect(screen.queryByText("Trial ended")).toBeNull();
  });

  // ── (a) Enable / Disable / Cancel are TENANT_ADMIN actions; an OPERATOR gets a read-only note ──

  it("an OPERATOR sees no Enable, Disable or Cancel button and a read-only note instead", async () => {
    mockAuthUser = { role: "OPERATOR" };
    mockPlansAddons = [ADDON, { ...ADDON, sku: "OCR_PACK", name: "OCR Pack" }];
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [{ sku: "ROUTE_PLUS", name: "Route Plus", monthly: 49 }] as never,
    });
    renderWithProviders(<BillingSettingsPage />);

    await screen.findByRole("button", { name: /change plan/i });
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
    expect(screen.getByText("Only a workspace admin can turn add-ons on or off.")).toBeVisible();
    expect(screen.getByText("Only a workspace admin can cancel the subscription.")).toBeVisible();
  });

  it("a TENANT_ADMIN sees the buttons and no read-only note", async () => {
    mockPlansAddons = [ADDON, { ...ADDON, sku: "OCR_PACK", name: "OCR Pack" }];
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [{ sku: "ROUTE_PLUS", name: "Route Plus", monthly: 49 }] as never,
    });
    renderWithProviders(<BillingSettingsPage />);

    expect(await screen.findByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Only a workspace admin/)).toBeNull();
  });
});

// ─── SA-690: a trial tenant's checkout refused because of add-ons it has switched on ───────────

describe("BillingSettingsPage — checkout errors", () => {
  const PENDING_MESSAGE =
    "Turn off Customer pack (+100) before adding your card, or contact support to set them up.";
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockCheckoutPending = false;
    mockCheckoutMutate.mockReset();
    mockSubscriptionView = subscriptionView({
      planKey: "LITE",
      planName: "Lite",
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      monthlyPrice: 99,
      paymentRequired: true,
    });
  });

  const failCheckout = (status: number, data: Record<string, unknown>) =>
    mockCheckoutMutate.mockImplementation((_v: unknown, o: any) =>
      o?.onError?.(Object.assign(new Error("Request failed"), { response: { status, data } })),
    );
  const clickComplete = async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Complete payment" }));
  };

  it("a 409 ADDON_BILLING_PENDING_CHECKOUT shows that error's own message", async () => {
    failCheckout(409, {
      code: API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT,
      message: PENDING_MESSAGE,
    });
    await clickComplete();
    // EXACTLY the server's text (it names the add-ons), not a generic toast or fixed copy.
    expect(await screen.findByText(PENDING_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(PENDING_MESSAGE);
    expect(screen.queryByText(/couldn't start checkout/i)).toBeNull();
  });

  it("is keyed on response.data.code, not the status: the same code on a non-409 still shows the message", async () => {
    failCheckout(400, {
      code: API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT,
      message: PENDING_MESSAGE,
    });
    await clickComplete();
    expect(await screen.findByText(PENDING_MESSAGE)).toBeInTheDocument();
  });

  it("a later retry clears the previous checkout error", async () => {
    failCheckout(409, {
      code: API_ERROR_CODES.ADDON_BILLING_PENDING_CHECKOUT,
      message: PENDING_MESSAGE,
    });
    const user = userEvent.setup();
    renderWithProviders(<BillingSettingsPage />);
    await user.click(await screen.findByRole("button", { name: "Complete payment" }));
    expect(await screen.findByText(PENDING_MESSAGE)).toBeInTheDocument();
    mockCheckoutMutate.mockReset(); // the retry succeeds (navigates away): no onError
    await user.click(screen.getByRole("button", { name: "Complete payment" }));
    expect(screen.queryByText(PENDING_MESSAGE)).toBeNull();
  });

  it("any other checkout failure shows fixed copy, never the server's text", async () => {
    failCheckout(409, { code: "SOMETHING_ELSE", message: "internal stripe detail" });
    await clickComplete();
    expect(
      await screen.findByText("We couldn't start checkout. Nothing was changed. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal stripe detail/)).toBeNull();
  });

  it("a checkout failure with no body at all shows the fixed copy", async () => {
    mockCheckoutMutate.mockImplementation((_v: unknown, o: any) => o?.onError?.(new Error("net")));
    await clickComplete();
    expect(
      await screen.findByText("We couldn't start checkout. Nothing was changed. Please try again."),
    ).toBeInTheDocument();
  });
});

// SA-733r6 (B4): the Billing card while an invoice is owed - Pay $X primary at the top (admins only), no plan
// purchase path, the autopay line when nothing is owed, and none of it in an operator's DOM.
describe("BillingSettingsPage - owed invoice / autopay (B4)", () => {
  const T0 = Date.now() - 2 * 86_400_000;
  const owed = (over: Partial<SubscriptionView> = {}): SubscriptionView =>
    subscriptionView({
      pastDueSince: new Date(T0).toISOString(),
      pastDueInvoiceId: "in_1",
      openInvoiceAmount: 149,
      billingContactEmail: "dana@acme.test",
      ...over,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
  });

  it("admin: Pay $149.00 is a primary button that opens the pay link; no Change plan / Choose a plan", async () => {
    mockSubscriptionView = owed();
    renderWithProviders(<BillingSettingsPage />);
    const pay = await screen.findByRole("button", { name: "Pay $149.00" });
    await userEvent.click(pay);
    expect(mockPortalMutate).toHaveBeenCalledWith({ intent: "pay" });
    expect(screen.queryByRole("button", { name: /change plan/i })).toBeNull();
    expect(screen.queryByText(/choose a plan|subscribe/i)).toBeNull();
  });

  it("paused admin: the read-only sentence with the money, Pay $149.00, and no old read-only banner", async () => {
    mockSubscriptionView = owed({ status: "READ_ONLY", readOnlyReason: "payment_overdue" });
    renderWithProviders(<BillingSettingsPage />);
    expect(
      await screen.findByText(
        "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay $149.00" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /choose a plan/i })).toBeNull();
  });

  it("operator: the sentence, the reason and the contact (your admin + e-mail); no pay control in the DOM", async () => {
    mockAuthUser = { role: "OPERATOR" };
    mockSubscriptionView = owed({ status: "READ_ONLY", readOnlyReason: "payment_overdue" });
    renderWithProviders(<BillingSettingsPage />);
    expect(
      await screen.findByText(
        "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue. To restore access, contact your admin (dana@acme.test).",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pay/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /update payment/i })).toBeNull();
  });

  it("nothing owed: the admin sees the autopay line with the next charge", async () => {
    mockSubscriptionView = subscriptionView({
      paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2099 },
      nextCharge: { amount: 149, date: "2099-12-01T12:00:00.000Z" },
    });
    renderWithProviders(<BillingSettingsPage />);
    expect(
      await screen.findByText("Autopay is on. Next charge: $149.00 on Dec 1."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pay/i })).toBeNull();
  });
});

// ─── Row 350 / SA-693: a comp add-on reads "Included", never a price ───────────────────────────

describe("BillingSettingsPage — comp add-ons (row 350)", () => {
  const rowOf = (name: string) => {
    const row = screen.getByText(name).closest(".py-3");
    if (!row) throw new Error(`no add-on row for ${name}`);
    return within(row as HTMLElement);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser = { role: "TENANT_ADMIN" };
    mockPlansAddons = [ADDON, { ...ADDON, sku: "OCR_PACK", name: "OCR Pack", sortOrder: 2 }];
  });

  it("a comp catalog add-on shows Included and no price; a paid one beside it is unchanged", async () => {
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [
        { sku: "ROUTE_PLUS", name: "Route Plus", quantity: 1, comp: true, monthly: null },
        { sku: "OCR_PACK", name: "OCR Pack", quantity: 1, comp: false, monthly: 49 },
      ],
    });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Route Plus");

    const comp = rowOf("Route Plus");
    expect(comp.getByText("Included")).toBeInTheDocument();
    expect(comp.getByText("Active")).toBeInTheDocument();
    expect(comp.queryByText(/\$/)).toBeNull();

    const paid = rowOf("OCR Pack");
    expect(paid.getByText("$49/mo")).toBeInTheDocument();
    expect(paid.queryByText("Included")).toBeNull();
  });

  it("an active add-on with no comp flag (an older server) still shows its price", async () => {
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [{ sku: "ROUTE_PLUS", name: "Route Plus", quantity: 1, monthly: 49 }],
    });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Route Plus");

    const row = rowOf("Route Plus");
    expect(row.getByText("$49/mo")).toBeInTheDocument();
    expect(row.queryByText("Included")).toBeNull();
  });

  it("a comp add-on outside the catalog reads Included · Managed by RouteFlow with no price", async () => {
    mockPlansAddons = [ADDON];
    mockSubscriptionView = subscriptionView({
      status: "ACTIVE",
      addons: [
        { sku: "SALES_AGENTS", name: "Sales agents", quantity: 1, comp: true, monthly: null },
        { sku: "MSRP", name: "MSRP", quantity: 1, comp: false, monthly: 29 },
      ],
    });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Sales agents");

    const comp = rowOf("Sales agents");
    expect(comp.getByText(/^Included · Managed by RouteFlow$/)).toBeInTheDocument();
    expect(comp.queryByText(/\$/)).toBeNull();

    expect(rowOf("MSRP").getByText("$29/mo · Managed by RouteFlow")).toBeInTheDocument();
  });
});
