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

// UX guide B19: "Trial conversion" was (non-trial tenants / all tenants), so a pilot with nobody paying read 100%.
describe("BillingPage Trial Conversion card (UX guide B19)", () => {
  const mrr = (over: Record<string, unknown> = {}) => ({
    mrr: 0,
    momDelta: 0,
    payingTenants: 0,
    unpricedActiveTenants: 0,
    zeroPricedActiveTenants: 0,
    activeWithoutSubscription: 0,
    ...over,
  });
  const serve = (overview: Record<string, unknown>, mrrBody: unknown | Error) =>
    mockGet.mockImplementation((url: string) => {
      if (url === "/platform-admin/billing/overview") return Promise.resolve({ data: overview });
      if (url === "/billing/admin/mrr") {
        return mrrBody instanceof Error
          ? Promise.reject(mrrBody)
          : Promise.resolve({ data: mrrBody });
      }
      throw new Error(`unexpected GET ${url}`);
    });
  const valueOf = (label: string) =>
    screen.getByText(label).parentElement!.parentElement!.textContent ?? "";

  beforeEach(() => mockGet.mockReset());

  it("is not 100% when no tenant is paying and none is in trial", async () => {
    serve({ ...BILLING_OVERVIEW, totalTenants: 3, trialTenants: 0 }, mrr({ payingTenants: 0 }));
    render(<BillingPage />);
    await screen.findByText("Trial Conversion");
    await screen.findByText("0 paying · 0 in trial");
    expect(valueOf("Trial Conversion")).not.toContain("100%");
    expect(valueOf("Trial Conversion")).toContain("—");
  });

  it("is paying / (paying + in trial)", async () => {
    serve({ ...BILLING_OVERVIEW, totalTenants: 9, trialTenants: 3 }, mrr({ payingTenants: 1 }));
    render(<BillingPage />);
    expect(await screen.findByText("1 paying · 3 in trial")).toBeInTheDocument();
    expect(valueOf("Trial Conversion")).toContain("25%");
  });

  it("shows a dash, never a guess, while the paying count is unknown", async () => {
    serve({ ...BILLING_OVERVIEW, totalTenants: 3, trialTenants: 0 }, new Error("down"));
    render(<BillingPage />);
    await screen.findByText("MRR unavailable");
    expect(valueOf("Trial Conversion")).toContain("—");
    expect(valueOf("Trial Conversion")).not.toMatch(/d+%/);
  });
});
