import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import AdminCreateTenantPage from "./page";

jest.mock("@/lib/admin-api", () => ({
  superAdminClient: {
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

const mockFetchPlanCatalog = jest.fn();

jest.mock("@/lib/api/platform-pricing", () => ({
  fetchPlanCatalog: () => mockFetchPlanCatalog(),
}));

function planEntry(planKey: string, sortOrder: number) {
  return {
    planKey,
    name: planKey,
    monthlyPrice: "0",
    annualPrice: null,
    isCustom: false,
    sortOrder,
  };
}

describe("AdminCreateTenantPage — plan <select> sourced from the catalog (T14)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("T14-2 / R24: renders options from fetchPlanCatalog, sorted by sortOrder, labeled via planLabel", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [
        planEntry("SCALE", 3),
        planEntry("ENTERPRISE", 4),
        planEntry("STARTER", 1),
        planEntry("GROWTH", 2),
      ],
    });

    render(<AdminCreateTenantPage />);

    const select = await screen.findByRole("combobox");
    await waitFor(() => {
      const options = Array.from(select.querySelectorAll("option"));
      expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
        "STARTER",
        "GROWTH",
        "SCALE",
        "ENTERPRISE",
      ]);
    });
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options.map((o) => o.textContent)).toEqual(["Starter", "Growth", "Scale", "Enterprise"]);
  });

  it("T14-3 / R25 (case A — rejects): falls back to a single enabled option for the current plan, with an inline unavailable message", async () => {
    mockFetchPlanCatalog.mockRejectedValue(new Error("network down"));

    render(<AdminCreateTenantPage />);

    await waitFor(() => {
      expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
    });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe(select.value);
    const submit = screen.getByRole("button", { name: /create tenant/i });
    expect(submit).not.toBeDisabled();
  });

  it("T14-3 / R25 (case B — empty catalog): falls back the same way when plans resolve empty", async () => {
    mockFetchPlanCatalog.mockResolvedValue({ version: 1, effectiveAt: null, plans: [] });

    render(<AdminCreateTenantPage />);

    await waitFor(() => {
      expect(screen.getByText(/plan catalog unavailable/i)).toBeInTheDocument();
    });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    const options = Array.from(select.querySelectorAll("option")) as HTMLOptionElement[];
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe(select.value);
    const submit = screen.getByRole("button", { name: /create tenant/i });
    expect(submit).not.toBeDisabled();
  });

  it("T14-4 / R26: resets form.plan to plans[0].planKey when the default (STARTER) isn't in the loaded catalog", async () => {
    mockFetchPlanCatalog.mockResolvedValue({
      version: 1,
      effectiveAt: null,
      plans: [planEntry("GROWTH", 1), planEntry("SCALE", 2)],
    });

    render(<AdminCreateTenantPage />);

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe("GROWTH");
    });
  });
});
