import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";

const restrictions = jest.fn();
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => restrictions(),
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));

const TITLES = [
  "Business & team",
  "Selling & catalog",
  "Orders & stock",
  "Notifications",
  "Compliance",
  "Integrations",
  "Billing",
];

beforeEach(() => {
  restrictions.mockReturnValue({ data: { enabled: true }, isLoading: false, isError: false });
});

function section(title: string) {
  const h = screen.getAllByText(title).find((el) => el.className.includes("font-semibold"));
  return h!.closest("div.break-inside-avoid") as HTMLElement;
}

describe("SettingsHub regroup", () => {
  it("shows the task groups for an admin", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of TITLES) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
    expect(screen.queryByText("Data & import")).not.toBeInTheDocument();
  });

  it("hides admin-only items from operators", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    expect(screen.queryByText("Regulated sections")).not.toBeInTheDocument();
    expect(screen.queryByText("Product labels")).not.toBeInTheDocument();
    expect(screen.getAllByText("Invoicing").length).toBeGreaterThan(0);
  });

  it("lists Selling restrictions under both Selling & catalog and Compliance", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    for (const t of ["Selling & catalog", "Compliance"]) {
      const link = within(section(t)).getByRole("link", { name: /selling restrictions/i });
      expect(link).toHaveAttribute("href", "/settings/restrictions");
    }
  });

  it("operators see Selling restrictions in both groups (read-only page)", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    for (const t of ["Selling & catalog", "Compliance"]) {
      // Compliance collapses to a single card for operators (other items are admin-only).
      const hrefs = within(section(t))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href"));
      expect(hrefs).toContain("/settings/restrictions");
    }
  });

  it("operators find it by search", () => {
    renderWithProviders(<SettingsHub isAdmin={false} />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "restrictions" },
    });
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(2);
  });

  it("search 'restrictions' finds it in both groups", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    fireEvent.change(screen.getByLabelText("Search settings"), {
      target: { value: "restrictions" },
    });
    // A group left with one item renders as a single card titled by the group.
    const hrefs = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href") === "/settings/restrictions");
    expect(hrefs).toHaveLength(2);
    expect(screen.getByText("Selling & catalog")).toBeInTheDocument();
    expect(screen.getByText("Compliance")).toBeInTheDocument();
  });

  it("mounts the route defaults card", () => {
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });
});

describe("SettingsHub readiness banner", () => {
  it("shows the banner with an admin link when the master switch is off", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByRole("status")).toHaveTextContent(/selling restrictions are off/i);
    expect(within(screen.getByRole("status")).getByRole("link")).toHaveAttribute(
      "href",
      "/settings/restrictions",
    );
  });

  it("shows text but no link to operators", () => {
    restrictions.mockReturnValue({ data: { enabled: false }, isLoading: false, isError: false });
    renderWithProviders(<SettingsHub isAdmin={false} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/selling restrictions are off/i);
    expect(within(banner).queryByRole("link")).not.toBeInTheDocument();
  });

  it("no banner when enabled, loading, or errored", () => {
    for (const r of [
      { data: { enabled: true }, isLoading: false, isError: false },
      { data: undefined, isLoading: true, isError: false },
      { data: undefined, isLoading: false, isError: true },
    ]) {
      restrictions.mockReturnValue(r);
      const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      unmount();
    }
  });
});
