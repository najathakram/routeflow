import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { TenantPricingCard } from "./TenantPricingCard";

/**
 * SA-1206 R2: the "Card payment link" block. The API client is mocked at the module boundary; every figure on
 * screen is the plan JSON's own. The checkout URL is never printed by these specs.
 */
const mockFetchPricing = jest.fn();
const mockCheckout = jest.fn();
const mockFetchPlan = jest.fn();
const mockOpen = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchTenantPricing: (id: string) => mockFetchPricing(id),
  createTenantCheckout: (...a: unknown[]) => mockCheckout(...a),
}));
jest.mock("@/lib/api/platform-catchup", () => ({
  ...jest.requireActual("@/lib/api/platform-catchup"),
  fetchCatchupPlan: (id: string) => mockFetchPlan(id),
  openCatchupCheckout: (...a: unknown[]) => mockOpen(...a),
}));

const TENANT_ID = "tenant-1";
const LINK = "https://checkout.example.test/c/pay/cs_test_link";

const pricing = {
  resolvable: true,
  planKey: "GROWTH",
  planName: "Growth",
  monthly: 99,
  annual: 990,
  source: "override",
  currency: "usd",
  override: { monthly: 99, annual: null },
  subscription: { stripeSubId: null, status: "none", periodEnd: null, billingInterval: "month" },
};

/** An invoiced-by-hand business, eligible: paid to Oct 26, a $61.25 line to Nov 1, then $99/month. */
const eligible = (over: Record<string, unknown> = {}) => ({
  tenantClass: "PRODUCTION",
  tenantStatus: "ACTIVE",
  eligible: true,
  ineligible: [],
  refusals: [],
  claimState: null,
  hasStripeSubscription: false,
  externalPayment: true,
  monthlyCents: 9900, // the base plan alone
  recurringCents: 14800, // the plan plus one $49 add-on: what the session bills every month
  rfInvoices: { open: 1, paid: 1 },
  plan: {
    ok: true,
    shape: "trial_one_time",
    paidThrough: "2026-10-26T09:00:00.000Z",
    trialEndAt: "2026-11-01T12:00:00.000Z",
    stub: {
      from: "2026-10-26T09:00:00.000Z",
      to: "2026-11-01T12:00:00.000Z",
      label: "Oct 26 to Oct 31, 2026 subscription",
      lines: [{ code: "PLAN", kind: "PLAN", cents: 6125 }],
      totalCents: 6125,
      belowStripeMinimum: false,
    },
    voidInvoiceIds: ["inv_open"],
  },
  ...over,
});

const refused = (over: Record<string, unknown> = {}) =>
  eligible({
    eligible: false,
    ineligible: ["manual_marker_without_period"],
    refusals: [API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD],
    plan: { ok: false, reason: "manual_marker_without_period" },
    ...over,
  });

/** A business that already has a Stripe subscription (the pilot shape): never a catch-up. */
const stripeBilled = () => ({
  ...eligible(),
  eligible: false,
  ineligible: ["has_stripe_subscription"],
  refusals: [API_ERROR_CODES.CATCHUP_NEEDS_RULING],
  hasStripeSubscription: true,
  externalPayment: true, // invoiced by hand AND a Stripe subscription: the SA-1146 exclusion
});

const catchupPosts = () => mockOpen.mock.calls.length;
const renderCard = () => render(<TenantPricingCard tenantId={TENANT_ID} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchPlan.mockReset();
  mockOpen.mockReset();
  mockFetchPricing.mockResolvedValue(pricing);
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
});

describe("TenantPricingCard: the card payment link block", () => {
  it("an invoiced-by-hand business shows the preview, hides the ordinary Checkout, and posts exactly stub.totalCents", async () => {
    mockFetchPlan.mockResolvedValue(eligible());
    mockOpen.mockResolvedValue({
      checkoutUrl: LINK,
      sessionId: "cs_1",
      stubCents: 6125,
      shape: "trial_one_time",
    });
    renderCard();

    expect(await screen.findByText("Paid through Oct 26, 2026")).toBeInTheDocument();
    expect(
      screen.getByText(
        "When they pay, they're charged $61.25 for the Oct 26 to Oct 31, 2026 subscription",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$148.00/month from Nov 1, 2026")).toBeInTheDocument();
    expect(
      screen.getByText("1 open RouteFlow invoice is closed when they pay"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create checkout session" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Billing interval")).not.toBeInTheDocument();

    // the confirm repeats the amount and the date before anything is posted
    fireEvent.click(screen.getByRole("button", { name: "Create payment link" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/charged \$61\.25/)).toBeInTheDocument();
    expect(within(dialog).getByText(/from Nov 1, 2026/)).toBeInTheDocument();
    expect(catchupPosts()).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create payment link" }));

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(mockOpen).toHaveBeenCalledWith(TENANT_ID, 6125);
    expect(await screen.findByText("Payment link ready")).toBeInTheDocument();
    expect(screen.getByText("Copy it now. It can't be shown again.")).toBeInTheDocument();
    expect(mockCheckout).not.toHaveBeenCalled();
  });

  it("the confirm tells the admin to check Paid through against what the business paid before sending (SA-1210)", async () => {
    mockFetchPlan.mockResolvedValue(eligible());
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Create payment link" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "Check that 'Paid through' matches what this business has paid. If they paid by bank and it isn't shown, record it first with Activate manually.",
      ),
    ).toBeInTheDocument();
    expect(catchupPosts()).toBe(0);
  });

  it("the Copy button copies the link, and nothing else is told the link", async () => {
    mockFetchPlan.mockResolvedValue(eligible());
    mockOpen.mockResolvedValue({
      checkoutUrl: LINK,
      sessionId: "cs_1",
      stubCents: 6125,
      shape: "x",
    });
    const logs = [
      jest.spyOn(console, "log"),
      jest.spyOn(console, "info"),
      jest.spyOn(console, "warn"),
    ];
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Create payment link" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Create payment link",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy payment link" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(LINK));
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("cs_test_link");
      spy.mockRestore();
    }
    // no toast: the link lives only in the block itself
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the stub-free trial shape says nothing is charged today", async () => {
    const e = eligible() as { plan: Record<string, unknown> };
    mockFetchPlan.mockResolvedValue({
      ...e,
      plan: { ...e.plan, shape: "trial", stub: { ...(e.plan.stub as object), totalCents: 0 } },
    });
    renderCard();
    expect(await screen.findByText("Nothing is charged today")).toBeInTheDocument();
    expect(screen.queryByText(/they're charged/)).not.toBeInTheDocument();
  });

  it("a refusal shows the coded sentence and no button", async () => {
    mockFetchPlan.mockResolvedValue(refused());
    renderCard();
    expect(
      await screen.findByText(/manual activation recorded without a paid period/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create payment link" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create checkout session" }),
    ).not.toBeInTheDocument();
    expect(catchupPosts()).toBe(0);
  });

  it("a held claim reads as an open link, with no button", async () => {
    mockFetchPlan.mockResolvedValue(
      refused({
        ineligible: ["claim_held"],
        refusals: [API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE],
        claimState: "SESSION_OPEN",
      }),
    );
    renderCard();
    expect(
      await screen.findByText(
        "A payment link is already open for this business. Wait for it to be paid or to expire.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create payment link" })).not.toBeInTheDocument();
  });

  it("a pilot-shaped business (Stripe subscription) keeps the ordinary Checkout and makes zero catch-up POSTs", async () => {
    mockFetchPlan.mockResolvedValue(stripeBilled());
    renderCard();
    expect(
      await screen.findByRole("button", { name: "Create checkout session" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("card-payment-link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create payment link" })).not.toBeInTheDocument();
    expect(catchupPosts()).toBe(0);
  });

  it("a failed plan read shows neither block, only a retry; the retry reads again", async () => {
    mockFetchPlan.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(stripeBilled());
    renderCard();
    expect(
      await screen.findByText("Couldn't check how this business pays. Try again."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create checkout session" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-payment-link")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Billing interval")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("button", { name: "Create checkout session" }),
    ).toBeInTheDocument();
    expect(mockFetchPlan).toHaveBeenCalledTimes(2);
  });

  it("neither block shows while the plan is still being read", async () => {
    let resolve!: (v: unknown) => void;
    mockFetchPlan.mockReturnValue(new Promise((r) => (resolve = r)));
    renderCard();
    expect(await screen.findByText("Checking how this business pays…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create checkout session" }),
    ).not.toBeInTheDocument();
    resolve(stripeBilled());
    expect(
      await screen.findByRole("button", { name: "Create checkout session" }),
    ).toBeInTheDocument();
  });

  it("CATCHUP_AMOUNT_CHANGED re-reads the plan, shows the new amount, and never re-posts", async () => {
    const changed = eligible() as { plan: { stub: Record<string, unknown> } };
    mockFetchPlan.mockResolvedValueOnce(eligible()).mockResolvedValue({
      ...changed,
      plan: { ...changed.plan, stub: { ...changed.plan.stub, totalCents: 7000 } },
    });
    mockOpen.mockRejectedValue({
      response: { status: 409, data: { code: API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED } },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Create payment link" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Create payment link",
      }),
    );

    expect(
      await screen.findByText("The amount changed. Check the new amount and try again."),
    ).toBeInTheDocument();
    expect(await screen.findByText(/they're charged \$70\.00/)).toBeInTheDocument();
    expect(mockFetchPlan).toHaveBeenCalledTimes(2);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Payment link ready")).not.toBeInTheDocument();
  });
});
