/** B1371 (SA-1175 K5): the scheduled-downgrade banner says nothing is turned off. */
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import BillingSettingsPage from "./page";

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

let mockUsage: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => ({
    data: {
      planKey: "SCALE",
      planName: "Scale",
      status: "ACTIVE",
      cycle: "MONTHLY",
      monthlyPrice: 300,
      annualPrice: null,
      isCustom: false,
      renewalAt: "2026-12-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: "GROWTH",
      downgradeEffectiveAt: "2026-12-01T00:00:00Z",
      trialEndsAt: null,
      addons: [],
      flags: [],
      paymentRequired: false,
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useUsage: () => ({ data: mockUsage, isLoading: false }),
  usePlans: () => ({
    data: {
      plans: [{ planKey: "GROWTH", name: "Growth", customersIncluded: 250 }],
      addons: [],
    },
    isLoading: false,
  }),
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

const bannerText = () => screen.getByText(/Changes to/).textContent ?? "";

describe("B1371 scheduled downgrade banner", () => {
  afterEach(() => {
    mockUsage = [];
  });

  it("says the team, customers and data stay, and keeps Keep current plan", async () => {
    mockUsage = [{ meter: "CUSTOMERS", used: 40, included: 400, remaining: 360, resetsAt: null }];
    renderWithProviders(<BillingSettingsPage />);
    expect(await screen.findByText(/Changes to/)).toBeInTheDocument();
    expect(bannerText()).toMatch(
      /^Changes to Growth on .+\. Your team, customers and data stay as they are\.$/,
    );
    expect(bannerText()).not.toMatch(/read-only/i);
    expect(screen.getByRole("button", { name: "Keep current plan" })).toBeInTheDocument();
  });

  it("adds the customer sentence when over the target plan's allowance", async () => {
    mockUsage = [{ meter: "CUSTOMERS", used: 300, included: 400, remaining: 100, resetsAt: null }];
    renderWithProviders(<BillingSettingsPage />);
    await screen.findByText(/Changes to/);
    expect(bannerText()).toContain(
      "You have 300 customers and Growth includes 250. After 7 days over, new customers need a Customer pack or a bigger plan.",
    );
  });
});
