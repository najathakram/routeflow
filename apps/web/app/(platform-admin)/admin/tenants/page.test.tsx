import * as React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import AdminTenantsPage from "./page";
import { superAdminClient } from "@/lib/admin-api";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockPatch = jest.fn();
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
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

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

describe("Back office P2: the list row no longer carries Suspend or Impersonate", () => {
  it.each(["TRIAL", "ACTIVE", "READ_ONLY"])(
    "a %s tenant's row has View only: no Suspend, no Impersonate, no Delete, no Reactivate",
    async (status) => {
      mockStatus = status;
      render(<AdminTenantsPage />);
      await screen.findByRole("link", { name: "View" });
      expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Impersonate" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
    },
  );

  it("a SUSPENDED tenant's row keeps Reactivate and Delete, and still no Suspend or Impersonate", async () => {
    mockStatus = "SUSPENDED";
    render(<AdminTenantsPage />);
    await screen.findByRole("button", { name: "Reactivate" });
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Suspend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Impersonate" })).toBeNull();
  });

  it("Reactivate sends one PATCH to ACTIVE; a failure shows fixed copy, not the server's text", async () => {
    mockStatus = "SUSPENDED";
    render(<AdminTenantsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("/platform-admin/tenants/t-1/status", {
        status: "ACTIVE",
      }),
    );
    expect(mockPatch).toHaveBeenCalledTimes(1);

    mockPatch.mockRejectedValueOnce({ response: { data: { message: "db constraint x_fk" } } });
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));
    expect(
      await screen.findByText("Couldn't change the tenant's status. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/x_fk/)).toBeNull();
  });
});

describe("Back office P1: Delete on the tenants list uses the shared dialog", () => {
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
});

describe("SA-1: the tenants list plan filter offers the same plans as every other plan control", () => {
  it("lists the catalog plans in catalog order (not the legacy STARTER/PROFESSIONAL/ENTERPRISE)", async () => {
    render(<AdminTenantsPage />);
    const select = (await screen.findByRole("combobox", {
      name: "Filter by plan",
    })) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.value)).toEqual([
        "",
        "STARTER",
        "GROWTH",
        "SCALE",
        "ENTERPRISE",
      ]),
    );
    expect(Array.from(select.options).map((o) => o.value)).not.toContain("PROFESSIONAL");
  });

  it("picking GROWTH asks the server for plan=GROWTH", async () => {
    render(<AdminTenantsPage />);
    const select = (await screen.findByRole("combobox", {
      name: "Filter by plan",
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(5));
    fireEvent.change(select, { target: { value: "GROWTH" } });
    await waitFor(() =>
      expect(
        (superAdminClient.get as jest.Mock).mock.calls.some(([url]) =>
          String(url).includes("plan=GROWTH"),
        ),
      ).toBe(true),
    );
  });
});
