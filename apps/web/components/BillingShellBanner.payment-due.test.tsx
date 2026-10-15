import * as React from "react";
import type { PaymentDueView, SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BillingShellBanner } from "./BillingShellBanner";

let mockDue: PaymentDueView | undefined;
jest.mock("@/lib/api/payment-due", () => ({
  usePaymentDue: () => ({ data: mockDue }),
  usePayPaymentDue: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders",
}));
jest.mock("@/lib/counter-cart-signal", () => ({ guardCounterLeave: () => false }));

const DAY = 86_400_000;
const view = (daysAgo: number, over: Partial<SubscriptionView> = {}): SubscriptionView => ({
  planKey: "TEAM",
  planName: "Team",
  status: "ACTIVE",
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
  billingContactEmail: "dana@acme.test",
  pauseEnforced: true,
  pastDueSince: new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString(),
  pastDueInvoiceId: "in_1",
  openInvoiceAmount: 149,
  ...over,
});
const healthy = () =>
  view(0, { pastDueSince: null, pastDueInvoiceId: null, openInvoiceAmount: null });
const DUE: PaymentDueView = {
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  mockDue = undefined;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("BillingShellBanner - payment due slot", () => {
  it("a healthy workspace with a payment due shows the payment-due banner, not the strip", () => {
    mockDue = DUE;
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.getByTestId("payment-due-banner")).toHaveAttribute("data-state", "past-due");
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("operator sees it too, without a pay control", () => {
    mockDue = DUE;
    renderWithProviders(<BillingShellBanner scope="acme" view={healthy()} userRole="OPERATOR" />);
    expect(screen.getByTestId("payment-due-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
    expect(screen.getByText("Ask your account admin to pay.")).toBeInTheDocument();
  });

  it("not due: renders nothing for a healthy workspace", () => {
    mockDue = { ...DUE, due: false };
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("failed renewal replaces the grace strip (day 2)", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={view(2)} userRole="TENANT_ADMIN" />);
    expect(await screen.findByTestId("payment-due-banner")).toHaveAttribute(
      "data-state",
      "failed-renewal",
    );
    expect(screen.getByRole("button", { name: "Update card" })).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("failed renewal replaces the overdue strip (pause not enforced)", () => {
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={view(9, { pauseEnforced: false })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(screen.getByTestId("payment-due-banner")).toHaveAttribute(
      "data-state",
      "failed-renewal",
    );
  });

  it("the final day keeps the strip", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={view(6)} userRole="TENANT_ADMIN" />);
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute(
      "data-state",
      "final-day",
    );
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("read-only keeps the strip even when a payment is also due", async () => {
    mockDue = DUE;
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={view(8, { status: "READ_ONLY", readOnlyReason: "payment_overdue" })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute(
      "data-state",
      "read-only",
    );
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("buyers never see it", () => {
    mockDue = DUE;
    const { container } = renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="CUSTOMER" />,
    );
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/payment/i);
  });
});
