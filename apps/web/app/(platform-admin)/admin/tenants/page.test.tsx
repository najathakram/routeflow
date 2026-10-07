import * as React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import AdminTenantsPage from "./page";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockPatch = jest.fn();
const mockPost = jest.fn();

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    get: jest.fn(() =>
      Promise.resolve({
        data: {
          data: [
            {
              id: "t-1",
              slug: "acme",
              name: "Acme",
              status: "TRIAL",
              plan: "STARTER",
              planKey: "STARTER",
              trialEndsAt: null,
              businessName: "Acme",
              counts: { users: 1, customers: 0, orders: 0 },
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          meta: { total: 1, page: 1, limit: 50, pages: 1, deletedCount: 0 },
        },
      }),
    ),
    patch: (...args: unknown[]) => mockPatch(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.mock("@/lib/impersonation", () => ({ setImpersonation: jest.fn() }));
jest.mock("@/lib/tenant-cookie", () => ({ setTenantCookie: jest.fn() }));

const mockFetchPlanCatalog = jest.fn();
jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

function entry(planKey: string, sortOrder: number) {
  return {
    planKey,
    name: planKey,
    monthlyPrice: "0",
    annualPrice: null,
    isCustom: false,
    sortOrder,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPatch.mockResolvedValue({ data: {} });
  // Rejects so a confirmed impersonation never navigates jsdom; only the request is asserted.
  mockPost.mockRejectedValue({ response: { data: { message: "No active admin" } } });
  mockFetchPlanCatalog.mockResolvedValue({
    version: 11,
    effectiveAt: null,
    plans: [entry("GROWTH", 1), entry("STARTER", 0), entry("ENTERPRISE", 3), entry("SCALE", 2)],
  });
});

describe("REG-B857: tenants list bulk Change Plan", () => {
  it("REG-B857 T4: the bulk 'New plan' select offers the catalog plans and applies GROWTH", async () => {
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select acme" }));
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));

    const select = (await screen.findByRole("combobox", { name: "New plan" })) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        "STARTER",
        "GROWTH",
        "SCALE",
        "ENTERPRISE",
      ]),
    );

    fireEvent.change(select, { target: { value: "GROWTH" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/platform-admin/tenants/t-1/plan", {
        plan: "GROWTH",
      }),
    );
  });
  it("REG-B857 T5: while the catalog is loading, the bulk select shows the plan it will submit", async () => {
    mockFetchPlanCatalog.mockReturnValue(new Promise(() => {}));
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select acme" }));
    fireEvent.click(screen.getByRole("button", { name: "Change Plan" }));

    const select = (await screen.findByRole("combobox", { name: "New plan" })) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["STARTER"]);
    expect(select.value).toBe("STARTER");
  });
});

describe("Back office P1: Impersonate on the tenants list asks first", () => {
  it("click opens a dialog naming the tenant and sends NOTHING; Cancel sends nothing; Confirm sends one request", async () => {
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Impersonate" }));

    const dialog = await screen.findByRole("dialog", { name: "Impersonate Acme?" });
    expect(mockPost).not.toHaveBeenCalled();
    // The list row does not know the acting user, so the dialog says so plainly.
    expect(within(dialog).getByText("its admin")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    const again = await screen.findByRole("dialog", { name: "Impersonate Acme?" });
    fireEvent.click(within(again).getByRole("button", { name: "Impersonate" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/platform-admin/tenants/t-1/impersonate");
  });

  it("Escape closes the dialog without a request", async () => {
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Impersonate" }));
    await screen.findByRole("dialog", { name: "Impersonate Acme?" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
