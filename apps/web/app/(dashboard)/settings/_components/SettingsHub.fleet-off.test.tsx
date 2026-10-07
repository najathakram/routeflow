import * as React from "react";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { SettingsHub } from "./SettingsHub";

// M3: fleet-off has no route defaults: neither the hub item nor the card. Fleet-on keeps both.
let fleet = true;
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("./RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));

describe("SettingsHub — fleet-off", () => {
  it("fleet-OFF: no 'Route defaults' item and no card", () => {
    fleet = false;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.queryByText("Route defaults")).not.toBeInTheDocument();
    expect(screen.queryByText("route-defaults-card")).not.toBeInTheDocument();
  });

  it("fleet-ON (today's UI, unchanged): the item and the card are there", () => {
    fleet = true;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("Route defaults")).toBeInTheDocument();
    expect(screen.getByText("route-defaults-card")).toBeInTheDocument();
  });

  it("fleet-OFF: the user-management card does not promise drivers; fleet-ON keeps today's words", () => {
    fleet = false;
    const { unmount } = renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("Team members, roles, passwords")).toBeInTheDocument();
    expect(screen.queryByText(/drivers/i)).not.toBeInTheDocument();
    unmount();

    fleet = true;
    renderWithProviders(<SettingsHub isAdmin />);
    expect(screen.getByText("Operators & drivers, roles, passwords")).toBeInTheDocument();
  });
});
