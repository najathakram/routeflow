import * as React from "react";
import type { PaymentDueView, SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen } from "@/test-utils/render";
import { BillingShellBanner } from "./BillingShellBanner";

let mockDue: PaymentDueView | undefined;
let mockQuery = "";
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
  useSearchParams: () => new URLSearchParams(mockQuery),
}));
jest.mock("@/lib/tenant-timezone", () => ({
  useTenantTimeZoneQuery: () => ({ zone: "America/New_York", isError: false, retry: jest.fn() }),
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
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};

beforeEach(() => {
  mockDue = undefined;
  mockQuery = "";
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

  it("?paid=1 suppresses the payment-due banner while the payment confirms", () => {
    mockDue = DUE;
    mockQuery = "paid=1";
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
  });

  it("without ?paid=1 the same read shows the banner", () => {
    mockDue = DUE;
    mockQuery = "other=1";
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.getByTestId("payment-due-banner")).toBeInTheDocument();
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

// SA-801: the card reminder takes the slot below a payable payment due and above the quiet strip.
const REMINDER: PaymentDueView = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: true,
  chargeStartsOn: new Date(Date.now() + 23 * DAY).toISOString(),
  cardBy: new Date(Date.now() + 20 * DAY).toISOString(),
};

describe("BillingShellBanner - card reminder slot", () => {
  it("today (no reminder in the read) nothing shows; with it, the banner shows for an admin", () => {
    mockDue = { ...REMINDER, cardNeeded: false, chargeStartsOn: null, cardBy: null };
    const { unmount } = renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.queryByTestId("card-reminder-banner")).toBeNull();
    unmount();
    mockDue = REMINDER;
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.getByTestId("card-reminder-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add card" })).toBeInTheDocument();
    expect(screen.queryByTestId("payment-due-banner")).toBeNull();
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("an operator sees it without Add card", () => {
    mockDue = REMINDER;
    renderWithProviders(<BillingShellBanner scope="acme" view={healthy()} userRole="OPERATOR" />);
    expect(screen.getByTestId("card-reminder-banner")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
    expect(screen.getByText(/^Ask your account admin to add a card before /)).toBeInTheDocument();
  });

  it("?paid=1 suppresses it while the session confirms", () => {
    mockDue = REMINDER;
    mockQuery = "paid=1";
    renderWithProviders(
      <BillingShellBanner scope="acme" view={healthy()} userRole="TENANT_ADMIN" />,
    );
    expect(screen.queryByTestId("card-reminder-banner")).toBeNull();
  });

  it("the final day keeps the strip", async () => {
    mockDue = REMINDER;
    renderWithProviders(<BillingShellBanner scope="acme" view={view(6)} userRole="TENANT_ADMIN" />);
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute(
      "data-state",
      "final-day",
    );
    expect(screen.queryByTestId("card-reminder-banner")).toBeNull();
  });

  it("read-only keeps the strip", async () => {
    mockDue = REMINDER;
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
    expect(screen.queryByTestId("card-reminder-banner")).toBeNull();
  });

  it("buyers never see it", () => {
    mockDue = REMINDER;
    renderWithProviders(<BillingShellBanner scope="acme" view={healthy()} userRole="CUSTOMER" />);
    expect(screen.queryByTestId("card-reminder-banner")).toBeNull();
  });
});
