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
const mockDelete = jest.fn();
let mockStatus = "TRIAL";

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
              status: mockStatus,
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
    delete: (...args: unknown[]) => mockDelete(...args),
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
  mockDelete.mockResolvedValue({ data: {} });
  mockStatus = "TRIAL";
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

    const dialog = await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    expect(mockPost).not.toHaveBeenCalled();
    // The list row does not know the acting user, so the dialog says so plainly.
    expect(within(dialog).getByText("its admin")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Impersonate" }));
    const again = await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    fireEvent.click(within(again).getByRole("button", { name: "Impersonate" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/platform-admin/tenants/t-1/impersonate");
  });

  it("Escape closes the dialog without a request", async () => {
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Impersonate" }));
    await screen.findByRole("dialog", { name: "Impersonate Acme (acme)?" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("Back office P1: Suspend and Delete on the tenants list use the shared dialogs", () => {
  it("Suspend: the dialog names the tenant and slug; Cancel sends nothing; Confirm sends one PATCH", async () => {
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(dialog).getByText(/can't sign in while it's suspended/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mockPatch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const again = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    fireEvent.click(within(again).getByRole("button", { name: "Suspend" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/platform-admin/tenants/t-1/status", {
        status: "SUSPENDED",
      }),
    );
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it("Delete (a suspended tenant): the type-the-slug dialog; the button is red-gated on the exact slug; one DELETE", async () => {
    mockStatus = "SUSPENDED";
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme (acme)?" });
    const del = within(dialog).getByRole("button", { name: "Delete Tenant" });
    expect(del).toBeDisabled();
    expect(mockDelete).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Type the tenant slug to confirm deletion"), {
      target: { value: "acme" },
    });
    expect(del).toBeEnabled();
    fireEvent.click(del);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete).toHaveBeenCalledWith("/platform-admin/tenants/t-1");
  });

  it("a delete the server refuses shows FIXED copy inside the dialog (never the server's text); it stays open", async () => {
    mockStatus = "SUSPENDED";
    mockDelete.mockRejectedValueOnce({
      response: { status: 409, data: { message: "internal: tenant has live subscription rows" } },
    });
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Acme (acme)?" });
    fireEvent.change(within(dialog).getByLabelText("Type the tenant slug to confirm deletion"), {
      target: { value: "acme" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Tenant" }));
    expect(
      await within(dialog).findByText(
        "Only a suspended tenant can be deleted. Suspend it first, then delete.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internal: tenant has live subscription rows/)).toBeNull();
    expect(screen.getByRole("dialog", { name: "Delete Acme (acme)?" })).toBeInTheDocument();
  });

  it("a failed Suspend and a failed Impersonate show fixed copy, not the server's text", async () => {
    mockPatch.mockRejectedValueOnce({ response: { data: { message: "db constraint x_fk" } } });
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog", { name: 'Suspend "Acme (acme)"?' });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspend" }));
    expect(
      await screen.findByText("Couldn't change the tenant's status. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/x_fk/)).toBeNull();
  });
});
