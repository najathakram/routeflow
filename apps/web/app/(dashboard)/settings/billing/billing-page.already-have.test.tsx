import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import BillingSettingsPage from "./page";
import type { SubscriptionView } from "@/lib/api/billing";

/**
 * SA-1099 A-4 (WP5, rows L-3 and L-5): the add-on list shows a SKU the workspace already has the effect of as
 * "You already have this." with NO price and NO Turn on / Enable button, instead of offering it and refusing at the
 * confirm sheet. The server decides (`SubscriptionView.alreadyHaveAddonSkus`); the page only renders it. A capacity SKU
 * is never shown that way, even from a bad payload.
 */
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

let mockSubscriptionView: SubscriptionView;
let mockPlansAddons: Array<Record<string, unknown>> = [];

jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({
    data: mockSubscriptionView,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useUsage: () => ({ data: [], isLoading: false }),
  usePlans: () => ({ data: { plans: [], addons: mockPlansAddons }, isLoading: false }),
  useCancelSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  useEnableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useDisableAddon: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useProrationPreview: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
  }),
  useCreateCheckout: () => ({ mutate: jest.fn(), isPending: false }),
  useBillingPortal: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { role: "TENANT_ADMIN" },
    login: jest.fn(),
    logout: jest.fn(),
  }),
}));

const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: 25,
  unit: "tenant",
  includedAtPlan: null,
  meteredKey: null,
  capacityPerUnit: null,
  stackable: false,
  grantsFlags: ["flag.forecasting", "flag.analytics"],
  sortOrder: 1,
};
const PACK = {
  sku: "CUSTOMER_PACK_100",
  name: "Customer pack",
  monthlyPrice: 12,
  unit: "pack",
  includedAtPlan: null,
  meteredKey: "CUSTOMERS",
  capacityPerUnit: 100,
  stackable: true,
  grantsFlags: [],
  sortOrder: 2,
};

function view(
  over: Partial<SubscriptionView> & { alreadyHaveAddonSkus?: string[] },
): SubscriptionView {
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
    ...over,
  } as SubscriptionView;
}

const row = (name: string) =>
  within(screen.getByText(name).closest("[data-addon-row]") as HTMLElement);

beforeEach(() => {
  mockPlansAddons = [FORECASTING, PACK];
});

describe("L-3: the add-on list shows what the workspace already has as 'You already have this.'", () => {
  it("the Forecasting row says so, with no price and no Enable button; the other row is unchanged", async () => {
    mockSubscriptionView = view({ alreadyHaveAddonSkus: ["FORECASTING"] });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Forecasting");

    const forecasting = row("Forecasting");
    expect(forecasting.getByText("You already have this.")).toBeInTheDocument();
    expect(forecasting.queryByText(/\$/)).not.toBeInTheDocument();
    expect(forecasting.queryByRole("button")).not.toBeInTheDocument();

    const pack = row("Customer pack");
    expect(pack.getByText(/\$12(\.00)?\/mo/)).toBeInTheDocument();
    expect(pack.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(pack.queryByText("You already have this.")).not.toBeInTheDocument();
  });

  it("an older server (field absent) or an empty set: both rows are for sale as before", async () => {
    for (const set of [undefined, [] as string[]]) {
      mockSubscriptionView = view(set === undefined ? {} : { alreadyHaveAddonSkus: set });
      const r = renderWithProviders(<BillingSettingsPage />);
      await screen.findByText("Forecasting");
      expect(row("Forecasting").getByText(/\$25(\.00)?\/mo/)).toBeInTheDocument();
      expect(row("Forecasting").getByRole("button", { name: "Enable" })).toBeInTheDocument();
      expect(screen.queryByText("You already have this.")).not.toBeInTheDocument();
      r.unmount();
    }
  });

  it("a SKU the workspace holds as an active row keeps its Active state and Disable button", async () => {
    mockSubscriptionView = view({
      alreadyHaveAddonSkus: ["FORECASTING"],
      addons: [{ sku: "FORECASTING", name: "Forecasting", quantity: 1, monthly: 25 }],
    });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Forecasting");
    const forecasting = row("Forecasting");
    expect(forecasting.queryByText("You already have this.")).not.toBeInTheDocument();
    expect(forecasting.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });
});

describe("L-5: a capacity SKU is never shown as already had", () => {
  it("CUSTOMER_PACK_100 in the set (a bad payload) still renders a buy row", async () => {
    mockSubscriptionView = view({ alreadyHaveAddonSkus: ["CUSTOMER_PACK_100"] });
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText("Customer pack");
    const pack = row("Customer pack");
    expect(pack.getByText(/\$12(\.00)?\/mo/)).toBeInTheDocument();
    expect(pack.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByText("You already have this.")).not.toBeInTheDocument();
  });
});
