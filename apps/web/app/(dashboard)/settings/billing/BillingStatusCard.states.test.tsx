import * as React from "react";
import userEvent from "@testing-library/user-event";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { BillingStatusCard } from "./BillingStatusCard";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/settings/billing",
  useSearchParams: () => new URLSearchParams(),
}));
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn(), patch: jest.fn() },
}));

/**
 * SA-777 / billing-ux.md acceptance (RTL): the card renders each state's EXACT copy for an admin and an operator;
 * Processing shows no Pay; the operator DOM has no pay/portal button; Pay opens the hosted page in a new tab.
 */
function view(over: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    planKey: "GROWTH",
    planName: "Growth",
    status: "ACTIVE",
    cycle: "MONTHLY",
    monthlyPrice: 149,
    annualPrice: 1490,
    isCustom: false,
    renewalAt: null,
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    paymentRequired: false,
    readOnlyReason: null,
    billingContactEmail: "dana@example.test",
    paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2099 },
    nextCharge: { amount: 149, date: "2099-12-01T12:00:00.000Z", dateLabel: "Dec 1" },
    ...over,
  };
}
const card = (v: SubscriptionView, role = "TENANT_ADMIN") =>
  renderWithProviders(<BillingStatusCard sub={v} userRole={role} scope="acme" />);

describe("Billing card states (SA-777)", () => {
  beforeEach(() => post.mockReset());

  it("Current (admin): pill, '$149.00 / month', autopay line, only the portal button", () => {
    card(view({ billingState: "current", outstandingTotal: 0 }));
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("Current")).toBeInTheDocument();
    expect(within(c).getByText("$149.00 / month")).toBeInTheDocument();
    expect(
      within(c).getByText("Autopay on · Visa •••• 4242 · next charge Dec 1"),
    ).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: /^Pay (\$|now)/ })).toBeNull();
    expect(
      within(c).getByRole("button", { name: "Payment methods & invoices (opens Stripe)" }),
    ).toBeInTheDocument();
  });

  it("Payment due (admin): '$149.00 due by Oct 15' and Pay $149.00", () => {
    card(
      view({
        billingState: "due",
        outstandingTotal: 149,
        openInvoiceDueLabel: "Oct 15",
        payNowUrl: "https://pay.example/in_1",
      }),
    );
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("Payment due")).toBeInTheDocument();
    expect(within(c).getByText("$149.00 due by Oct 15")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Pay $149.00" })).toBeInTheDocument();
  });

  it("Overdue (admin): amber pill, '$149.00 overdue since Oct 1'", () => {
    card(view({ billingState: "overdue", outstandingTotal: 149, openInvoiceDueLabel: "Oct 1" }));
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("Overdue")).toBeInTheDocument();
    expect(within(c).getByText("$149.00 overdue since Oct 1")).toBeInTheDocument();
    expect(c.className).not.toMatch(/red/);
  });

  it("Processing (admin): the 3-5 business days line, NO Pay button, the portal stays", () => {
    card(view({ billingState: "processing", paymentProcessing: true, outstandingTotal: 149 }));
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("Processing")).toBeInTheDocument();
    expect(
      within(c).getByText("$149.00 payment processing — usually 3–5 business days"),
    ).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: /^Pay \$|^Pay now/ })).toBeNull();
    expect(
      within(c).getByRole("button", { name: "Payment methods & invoices (opens Stripe)" }),
    ).toBeInTheDocument();
  });

  it("Operator: the state and who to ask - NO pay and NO portal button in the DOM", () => {
    card(
      view({
        billingState: "overdue",
        openInvoiceDueLabel: "Oct 1",
        paymentMethodSummary: null,
        nextCharge: null,
      }),
      "OPERATOR",
    );
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("Overdue since Oct 1")).toBeInTheDocument();
    expect(within(c).queryAllByRole("button")).toHaveLength(0);
    expect(c.textContent).toContain("Only an admin can pay. Your admin: dana@example.test");
    expect(c.textContent).not.toContain("Dana");
    expect(within(c).getByRole("link", { name: "dana@example.test" })).toHaveAttribute(
      "href",
      "mailto:dana@example.test",
    );
  });

  it("Pay opens the oldest invoice's hosted page in a NEW tab, without the portal route", async () => {
    const open = jest.spyOn(window, "open").mockReturnValue(null);
    card(
      view({
        billingState: "overdue",
        outstandingTotal: 149,
        openInvoiceDueLabel: "Oct 1",
        payNowUrl: "https://pay.example/in_1",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Pay $149.00" }));
    expect(open).toHaveBeenCalledWith("https://pay.example/in_1", "_blank", "noopener,noreferrer");
    expect(post).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("the server could not say: no card, and never the word 'Current'", () => {
    card(view({ paymentMethodSummary: null, nextCharge: null }));
    expect(screen.queryByTestId("billing-card")).toBeNull();
    expect(screen.queryByText("Current")).toBeNull();
  });
});

describe("Billing card: Pay collects what the card says (lead ruling)", () => {
  it("two open invoices: the big number is the one Pay collects, the total is underneath, in the DOM", () => {
    card(
      view({
        billingState: "overdue",
        outstandingTotal: 298,
        payNowAmount: 149,
        openInvoiceCount: 2,
        openInvoiceDueLabel: "Oct 1",
        payNowUrl: "https://pay.example/in_1",
      }),
    );
    const c = screen.getByTestId("billing-card");
    expect(within(c).getByText("$149.00 overdue since Oct 1")).toBeInTheDocument();
    expect(within(c).getByText("Total open: $298.00 · 2 invoices")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Pay $149.00" })).toBeInTheDocument();
    expect(c.textContent).not.toContain("$298.00 overdue");
  });

  it("read-only while a payment settles: no Pay button, the portal stays", () => {
    card(
      view({
        status: "READ_ONLY",
        readOnlyReason: "payment_overdue",
        billingState: "processing",
        paymentProcessing: true,
        outstandingTotal: 149,
      }),
    );
    const c = screen.getByTestId("billing-card");
    expect(within(c).queryByRole("button", { name: /^Pay (\$|now)/ })).toBeNull();
    expect(
      within(c).getByRole("button", { name: "Payment methods & invoices (opens Stripe)" }),
    ).toBeInTheDocument();
  });
});

describe("Billing card: the contact is printed once (UX C1)", () => {
  it("operator, read-only: the e-mail appears exactly once in the card", () => {
    card(
      view({
        status: "READ_ONLY",
        readOnlyReason: "payment_overdue",
        billingState: "overdue",
        openInvoiceAmount: 149,
        paymentMethodSummary: null,
        nextCharge: null,
      }),
      "OPERATOR",
    );
    const c = screen.getByTestId("billing-card");
    expect((c.textContent ?? "").split("dana@example.test")).toHaveLength(2);
    expect(within(c).queryAllByRole("button")).toHaveLength(0);
  });

  it("operator, not read-only: the card's own contact line still appears once", () => {
    card(
      view({ billingState: "overdue", paymentMethodSummary: null, nextCharge: null }),
      "OPERATOR",
    );
    const c = screen.getByTestId("billing-card");
    expect((c.textContent ?? "").split("dana@example.test")).toHaveLength(2);
  });
});
