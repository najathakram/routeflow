import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import { TenantPricingCard } from "./TenantPricingCard";

const mockFetchPricing = jest.fn();
const mockCheckout = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchTenantPricing: (id: string) => mockFetchPricing(id),
  createTenantCheckout: (...a: unknown[]) => mockCheckout(...a),
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

async function openAndSubmit() {
  mockFetchPricing.mockResolvedValue(pricing);
  render(<TenantPricingCard tenantId="tenant-1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Create checkout session" }));
}

beforeEach(() => jest.clearAllMocks());

describe("admin checkout refused with CHECKOUT_ANCHOR_WINDOW", () => {
  it("shows fixed 'reopens at <local time>' copy, never the server's message", async () => {
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW,
          message: "raw server text that must never be shown",
          retryAt: "2026-11-01T00:01:00.000Z",
        },
      },
    });
    await openAndSubmit();
    expect(await screen.findByText(/Checkout reopens at/)).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
  });

  it("an unreadable retryAt falls back to fixed copy without a time", async () => {
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: { code: API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW, retryAt: "x" },
      },
    });
    await openAndSubmit();
    expect(await screen.findByText(/Checkout reopens in a few minutes/)).toBeInTheDocument();
  });
});

// SA-832b: the back-office "Create checkout session" (POST /platform-admin/tenants/:id/billing/checkout) is used by a
// super admin. A tenant a payment may not reinstate is refused with TENANT_ADMIN_LOCKED; the admin gets ADMIN-facing
// copy (what to do), never the tenant's "contact support" sentence and never the server's raw text.
describe("admin checkout refused with TENANT_ADMIN_LOCKED", () => {
  it("shows the admin wording, not the tenant copy or the server's message", async () => {
    mockCheckout.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: API_ERROR_CODES.TENANT_ADMIN_LOCKED,
          message: "raw server text that must never be shown",
        },
      },
    });
    await openAndSubmit();
    expect(
      await screen.findByText("This tenant is locked by an admin; change its status first."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
    expect(screen.queryByText(/contact support/i)).not.toBeInTheDocument();
  });
});
