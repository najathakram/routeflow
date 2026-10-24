import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BillingShellBanner } from "./BillingShellBanner";

let mockPath = "/orders";
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => mockPath,
}));

/** F1/F2 follow-up: on the Billing page the "Billing" action would link to the page already open: it is hidden. */
const base = (over: Partial<SubscriptionView> = {}): SubscriptionView =>
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
    readOnlyReason: "subscription_cancelled",
    billingContactEmail: "dana@acme.test",
    ...over,
  }) as SubscriptionView;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("BillingShellBanner on the Billing page", () => {
  it("elsewhere: the admin's read-only banner has a Billing link", () => {
    mockPath = "/orders";
    renderWithProviders(<BillingShellBanner scope="acme" view={base()} userRole="TENANT_ADMIN" />);
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
  });

  it("on /settings/billing: no link to the page you are on (banner)", () => {
    mockPath = "/settings/billing";
    renderWithProviders(<BillingShellBanner scope="acme" view={base()} userRole="TENANT_ADMIN" />);
    expect(screen.getByText(/read-only mode/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
  });

  it("on /settings/billing: no Billing action in the strip either (cancelled with an owed invoice)", async () => {
    mockPath = "/settings/billing";
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={base({ pastDueInvoiceId: "in_1", pastDueSince: new Date().toISOString() })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(await screen.findByTestId("subscription-strip")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
  });
});
