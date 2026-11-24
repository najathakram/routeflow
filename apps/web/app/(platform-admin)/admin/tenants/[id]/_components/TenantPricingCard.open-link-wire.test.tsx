import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TenantPricingCard } from "./TenantPricingCard";

/**
 * W-1338 PR-2 (R-100 F1): the real client over a mocked axios instance. Nest answers a null result with an empty body,
 * which axios hands back as "", so a link just created must survive an open-link read that comes back "".
 */
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (url: string) => mockGet(url),
    post: (url: string, body?: unknown) => mockPost(url, body),
  },
}));

const URL_1 = "https://checkout.example.test/c/pay/cs_test_wire";
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
const plan = {
  eligible: false,
  ineligible: [],
  refusals: [],
  hasStripeSubscription: false,
  externalPayment: false,
  monthlyCents: 9900,
  recurringCents: 9900,
  rfInvoices: { open: 0, paid: 0 },
  plan: { ok: false, reason: "x" },
};

beforeEach(() => {
  jest.resetAllMocks();
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  mockGet.mockImplementation(async (url: string) => {
    if (url.endsWith("/billing/open-link")) return { data: "" }; // the wire shape of null
    if (url.endsWith("/billing/catchup-plan")) return { data: plan };
    return { data: pricing };
  });
});

describe("TenantPricingCard over the wire", () => {
  it("an empty open-link body is no link, so Create is offered", async () => {
    render(<TenantPricingCard tenantId="tenant-1" />);
    expect(await screen.findByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(screen.queryByText("Payment link ready")).not.toBeInTheDocument();
  });

  it("a link just created stays shown when the follow-up read comes back empty", async () => {
    mockPost.mockResolvedValue({ data: { checkoutUrl: URL_1 } });
    render(<TenantPricingCard tenantId="tenant-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Create link" }),
    );
    await screen.findByText("Payment link ready");
    await waitFor(() =>
      expect(mockGet.mock.calls.filter(([u]) => String(u).endsWith("/open-link"))).toHaveLength(2),
    );
    expect(screen.getByTestId("card-payment-link-url")).toHaveTextContent(URL_1);
  });
});
