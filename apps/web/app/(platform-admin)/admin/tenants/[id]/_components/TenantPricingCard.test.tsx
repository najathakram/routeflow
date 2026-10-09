import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TenantPricingCard } from "./TenantPricingCard";

const mockFetchPricing = jest.fn();
const mockUpdate = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  ...jest.requireActual("@/lib/api/platform-pricing"),
  fetchTenantPricing: (id: string) => mockFetchPricing(id),
  updateTenantPriceOverride: (id: string, body: unknown) => mockUpdate(id, body),
  createTenantCheckout: jest.fn(),
}));

const TENANT_ID = "tenant-1";

const pricing = (stripeSubId: string | null = "sub_123") => ({
  resolvable: true,
  planKey: "GROWTH",
  planName: "Growth",
  monthly: 100,
  annual: 1000,
  source: "override",
  currency: "usd",
  override: { monthly: 100, annual: null },
  subscription: {
    stripeSubId,
    status: stripeSubId ? "active" : "none",
    periodEnd: null,
    billingInterval: "month",
  },
});

async function renderCard(stripeSubId: string | null = "sub_123") {
  mockFetchPricing.mockResolvedValue(pricing(stripeSubId));
  render(<TenantPricingCard tenantId={TENANT_ID} />);
  await screen.findByLabelText("Monthly (USD)");
}

async function saveWith(monthly: string) {
  fireEvent.change(screen.getByLabelText("Monthly (USD)"), { target: { value: monthly } });
  fireEvent.click(screen.getByRole("button", { name: "Save custom fee" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({
    ...pricing(),
    sync: { synced: true, proration: "none" },
  });
});

describe("TenantPricingCard — when the new price takes effect (SA-733 D8)", () => {
  it("defaults to the next billing date and sends effective=next_cycle", async () => {
    await renderCard();
    expect(screen.getByRole("radio", { name: /Next billing date/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Now, prorated/ })).not.toBeChecked();

    await saveWith("80");

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(TENANT_ID, {
        monthly: 80,
        annual: null,
        effective: "next_cycle",
      }),
    );
    expect(await screen.findByText(/at the next billing date/)).toBeInTheDocument();
  });

  it("choosing Now, prorated sends effective=now_prorated and the success text says so", async () => {
    mockUpdate.mockResolvedValue({
      ...pricing(),
      sync: { synced: true, proration: "create_prorations" },
    });
    await renderCard();
    fireEvent.click(screen.getByRole("radio", { name: /Now, prorated/ }));

    await saveWith("80");

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(TENANT_ID, {
        monthly: 80,
        annual: null,
        effective: "now_prorated",
      }),
    );
    expect(await screen.findByText(/prorated adjustment/)).toBeInTheDocument();
  });

  it("the confirmation names the chosen mode", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("radio", { name: /Now, prorated/ }));
    fireEvent.change(screen.getByLabelText("Monthly (USD)"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Save custom fee" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/prorated/i)).toBeInTheDocument();
  });

  it("a past-due subscription takes Now, prorated at its next invoice: the result says it was not prorated", async () => {
    mockUpdate.mockResolvedValue({
      ...pricing(),
      sync: { synced: true, proration: "none" },
    });
    await renderCard();
    fireEvent.click(screen.getByRole("radio", { name: /Now, prorated/ }));

    await saveWith("80");

    expect(await screen.findByText(/not prorated/i)).toBeInTheDocument();
    // N2: not only past due - a trial or an unpaid subscription takes proration none too.
    expect(screen.getByText(/isn't active \(trial, past due or unpaid\)/)).toBeInTheDocument();
    expect(screen.getByText(/next invoice/)).toBeInTheDocument();
  });

  it("with no live subscription the control is hidden and the request still carries next_cycle", async () => {
    await renderCard(null);
    expect(screen.queryByRole("radio", { name: /Now, prorated/ })).not.toBeInTheDocument();

    await saveWith("80");

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(TENANT_ID, {
        monthly: 80,
        annual: null,
        effective: "next_cycle",
      }),
    );
  });

  it("an API error (e.g. Stripe ahead) is shown verbatim", async () => {
    mockUpdate.mockRejectedValue({
      response: {
        data: { message: "Stripe now bills $80, the database still says $100 - reconcile" },
      },
    });
    await renderCard();
    await saveWith("80");
    expect(await screen.findByText(/Stripe now bills \$80/)).toBeInTheDocument();
  });
});
