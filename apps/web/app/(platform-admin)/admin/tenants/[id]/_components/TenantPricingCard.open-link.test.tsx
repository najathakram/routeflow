import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { TenantPricingCard } from "./TenantPricingCard";

/**
 * W-1338 PR-2 (SA-1267 rule 4): the one "Payment link" section. The API client is mocked at the module boundary; the
 * open link is whatever `GET …/billing/open-link` returns.
 */
const mockFetchPricing = jest.fn();
const mockFetchPlan = jest.fn();
const mockOpenLink = jest.fn();
const mockCancel = jest.fn();
const mockCheckout = jest.fn();
const mockCatchup = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchTenantPricing: (id: string) => mockFetchPricing(id),
  fetchOpenPaymentLink: (id: string) => mockOpenLink(id),
  cancelOpenPaymentLink: (id: string) => mockCancel(id),
  createTenantCheckout: (...a: unknown[]) => mockCheckout(...a),
}));
jest.mock("@/lib/api/platform-catchup", () => ({
  ...jest.requireActual("@/lib/api/platform-catchup"),
  fetchCatchupPlan: (id: string) => mockFetchPlan(id),
  openCatchupCheckout: (...a: unknown[]) => mockCatchup(...a),
}));

const TENANT_ID = "tenant-1";
const URL_1 = "https://checkout.example.test/c/pay/cs_test_open";
const FAR = "2099-03-04T15:30:00.000Z";
const FAR_LOCAL = new Date(FAR).toLocaleString([], {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const pricing = {
  resolvable: true,
  planKey: "GROWTH",
  planName: "Growth",
  monthly: 99,
  annual: 990,
  source: "catalog",
  currency: "usd",
  override: { monthly: null, annual: null },
  subscription: { stripeSubId: null, status: "none", periodEnd: null, billingInterval: "month" },
};
const byHand = {
  eligible: true,
  ineligible: [],
  refusals: [],
  hasStripeSubscription: false,
  externalPayment: true,
  monthlyCents: 9900,
  recurringCents: 9900,
  rfInvoices: { open: 0, paid: 0 },
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
    voidInvoiceIds: [],
  },
};
const stripeBilled = { ...byHand, externalPayment: false, eligible: false };

const renderCard = () => render(<TenantPricingCard tenantId={TENANT_ID} />);

beforeEach(() => {
  jest.resetAllMocks();
  mockFetchPricing.mockResolvedValue(pricing);
  mockFetchPlan.mockResolvedValue(stripeBilled);
  mockOpenLink.mockResolvedValue(null);
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
});

describe("TenantPricingCard: the one Payment link section", () => {
  it("an open card link is shown again after a reload, with no way to make a second", async () => {
    mockOpenLink.mockResolvedValue({ kind: "card", url: URL_1, expiresAt: FAR });
    renderCard();
    expect(await screen.findByText("Payment link ready")).toBeInTheDocument();
    expect(screen.getByTestId("card-payment-link-url")).toHaveTextContent(URL_1);
    expect(screen.getByText("Payment link")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    expect(mockCheckout).not.toHaveBeenCalled();
    expect(mockOpenLink).toHaveBeenCalledWith(TENANT_ID);
  });

  it("an open catch-up link is shown again in the same section", async () => {
    mockFetchPlan.mockResolvedValue(byHand);
    mockOpenLink.mockResolvedValue({ kind: "catch_up", url: URL_1, expiresAt: FAR });
    renderCard();
    expect(await screen.findByText("Payment link ready")).toBeInTheDocument();
    expect(screen.getByTestId("card-payment-link-url")).toHaveTextContent(URL_1);
    expect(screen.queryByRole("button", { name: "Create payment link" })).not.toBeInTheDocument();
    expect(mockCatchup).not.toHaveBeenCalled();
  });

  it("Copy writes exactly the open link", async () => {
    mockOpenLink.mockResolvedValue({ kind: "card", url: URL_1, expiresAt: FAR });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Copy payment link" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(URL_1));
  });

  it("says 'Works until' the local time of the API's own expiresAt", async () => {
    mockOpenLink.mockResolvedValue({ kind: "card", url: URL_1, expiresAt: FAR });
    renderCard();
    expect(await screen.findByText(`Works until ${FAR_LOCAL}`)).toBeInTheDocument();
  });

  it("Cancel link posts the cancel for this business and offers a new link", async () => {
    mockOpenLink.mockResolvedValue({ kind: "card", url: URL_1, expiresAt: FAR });
    mockCancel.mockResolvedValue(undefined);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel link" }));
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith(TENANT_ID);
    expect(screen.queryByText("Payment link ready")).not.toBeInTheDocument();
  });

  it("a failed cancel keeps the link and says so", async () => {
    mockOpenLink.mockResolvedValue({ kind: "card", url: URL_1, expiresAt: FAR });
    mockCancel.mockRejectedValue(new Error("boom"));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel link" }));
    expect(await screen.findByText("Couldn't cancel the link. Try again.")).toBeInTheDocument();
    expect(screen.getByText("Payment link ready")).toBeInTheDocument();
  });

  it("an expired link reads 'This link expired. Create a new one.' and shows no URL", async () => {
    mockOpenLink.mockResolvedValue({
      kind: "card",
      url: URL_1,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    renderCard();
    expect(await screen.findByText("This link expired. Create a new one.")).toBeInTheDocument();
    expect(screen.queryByText(URL_1)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy payment link" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("a new catch-up link shows its expiry from the API and is never logged", async () => {
    mockFetchPlan.mockResolvedValue(byHand);
    mockCatchup.mockResolvedValue({
      checkoutUrl: URL_1,
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
    mockOpenLink.mockResolvedValue({ kind: "catch_up", url: URL_1, expiresAt: FAR });
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Create payment link",
      }),
    );
    // the expiry arrives from the API read that follows the create
    expect(await screen.findByText(`Works until ${FAR_LOCAL}`)).toBeInTheDocument();
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("cs_test_open");
      spy.mockRestore();
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("within 91 minutes of a 1st the create says 'Payment opens again at <local time>'", async () => {
    const retryAt = "2026-12-01T00:01:00.000Z";
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: { code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW, retryAt },
      },
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    const local = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(await screen.findByText(`Payment opens again at ${local}`)).toBeInTheDocument();
  });

  it("a failed plan read shows a coded error with Retry, not an empty card", async () => {
    mockFetchPlan.mockRejectedValueOnce({
      response: { status: 409, data: { code: API_ERROR_CODES.CATCHUP_MANUAL_PERIOD_AHEAD } },
    });
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This account has a manual activation recorded without a paid period, so it stays on invoiced billing for now. Your RouteFlow contact will follow up.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(mockFetchPlan).toHaveBeenCalledTimes(2);
  });
});
