import * as React from "react";
import { render, screen } from "@testing-library/react";
import BillingPage from "./page";

const mockGet = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

const BILLING_OVERVIEW = {
  activeSubscriptions: 3,
  cancelPending: 0,
  totalTenants: 5,
  trialTenants: 2,
  subscriptions: [],
};

describe("BillingPage MRR card (REG-743-F1)", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("shows 'MRR unavailable' and renders no dollar figure when /billing/admin/mrr fails -- never a client-side estimate", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/platform-admin/billing/overview") {
        return Promise.resolve({ data: BILLING_OVERVIEW });
      }
      if (url === "/billing/admin/mrr") {
        return Promise.reject(new Error("network error"));
      }
      throw new Error(`unexpected GET ${url}`);
    });

    render(<BillingPage />);

    expect(await screen.findByText("MRR unavailable")).toBeInTheDocument();
    // The old client-side PLAN_PRICES estimate is gone entirely -- no dollar figure
    // renders anywhere on the page while the server rollup is down, not just a
    // relabeled one.
    expect(screen.queryByText(/^\$[\d,]/)).not.toBeInTheDocument();
  });

  it("renders the real server figure when the MRR endpoint succeeds", async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === "/platform-admin/billing/overview") {
        return Promise.resolve({ data: BILLING_OVERVIEW });
      }
      if (url === "/billing/admin/mrr") {
        return Promise.resolve({
          data: {
            mrr: 249,
            momDelta: 10,
            payingTenants: 1,
            unpricedActiveTenants: 0,
            zeroPricedActiveTenants: 0,
            activeWithoutSubscription: 0,
          },
        });
      }
      throw new Error(`unexpected GET ${url}`);
    });

    render(<BillingPage />);

    expect(await screen.findByText("$249.00")).toBeInTheDocument();
  });
});
