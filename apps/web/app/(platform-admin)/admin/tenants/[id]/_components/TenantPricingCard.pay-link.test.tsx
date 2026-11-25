import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { TenantPricingCard } from "./TenantPricingCard";

const mockFetchPricing = jest.fn();
const mockCheckout = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchTenantPricing: (id: string) => mockFetchPricing(id),
  fetchOpenPaymentLink: () => Promise.resolve(null),
  createTenantCheckout: (...a: unknown[]) => mockCheckout(...a),
}));

const mockFetchPlan = jest.fn();
jest.mock("@/lib/api/platform-catchup", () => ({
  ...jest.requireActual("@/lib/api/platform-catchup"),
  fetchCatchupPlan: (id: string) => mockFetchPlan(id),
}));

const pricing = {
  resolvable: true,
  planKey: "GROWTH",
  planName: "Growth",
  monthly: 100,
  annual: 1000,
  source: "catalog",
  currency: "usd",
  override: { monthly: null, annual: null },
  subscription: { stripeSubId: null, status: "none", periodEnd: null, billingInterval: "month" },
};
const URL_1 = "https://pay.example.test/session/abc";

async function renderCard() {
  mockFetchPricing.mockResolvedValue(pricing);
  render(<TenantPricingCard tenantId="tenant-1" />);
  return screen.findByRole("button", { name: "Create link" });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchPlan.mockResolvedValue({ externalPayment: false, hasStripeSubscription: false });
});

describe("ordinary payment link on the admin card", () => {
  it("offers no Annual choice and never posts an interval", async () => {
    mockCheckout.mockResolvedValue({ checkoutUrl: URL_1 });
    fireEvent.click(await renderCard());
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    await screen.findByText("Payment link ready");
    expect(screen.queryByLabelText("Billing interval")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Annual/ })).not.toBeInTheDocument();
    expect(mockCheckout).toHaveBeenCalledTimes(1);
    expect(mockCheckout.mock.calls[0]).toEqual(["tenant-1"]);
  });

  it("asks first: nothing is created until the confirm is accepted", async () => {
    mockCheckout.mockResolvedValue({ checkoutUrl: URL_1 });
    fireEvent.click(await renderCard());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create a payment link?")).toBeInTheDocument();
    expect(mockCheckout).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mockCheckout).not.toHaveBeenCalled();
  });

  it("shows the ready link with a Copy link button that writes exactly that link", async () => {
    mockCheckout.mockResolvedValue({ checkoutUrl: URL_1 });
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(await renderCard());
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Copy payment link" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(URL_1);
  });

  it("the 409 before the 1st reads 'Payment opens again at <local time>'", async () => {
    const retryAt = "2026-11-01T00:01:00.000Z";
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: { code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW, message: "raw", retryAt },
      },
    });
    fireEvent.click(await renderCard());
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    const local = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(await screen.findByText(`Payment opens again at ${local}`)).toBeInTheDocument();
  });

  it("an unreadable retryAt reads 'Payment opens again in a few minutes.'", async () => {
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: { code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW, retryAt: "x" },
      },
    });
    fireEvent.click(await renderCard());
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    expect(await screen.findByText("Payment opens again in a few minutes.")).toBeInTheDocument();
  });
});
