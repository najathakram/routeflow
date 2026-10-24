import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import AnalyticsPage from "./page";

// Fleet-off clean UI: no routes or drivers means no Operations (route + driver performance) tab.
// Fleet-on keeps it.
let fleet = true;
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    // never answers: the tabs stay in their loading state, only the tab strip is under test
    get: jest.fn(() => new Promise(() => {})),
    post: jest.fn(),
  },
}));

describe("Analytics — fleet-off clean UI", () => {
  it("fleet-OFF: no Operations tab; Revenue, Products and Customers stay", async () => {
    fleet = false;
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByRole("button", { name: /revenue/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /products & inventory/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /customers/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /operations/i })).not.toBeInTheDocument();
  });

  it("fleet-ON (today's UI, unchanged): the Operations tab is there", async () => {
    fleet = true;
    renderWithProviders(<AnalyticsPage />);
    expect(await screen.findByRole("button", { name: /operations/i })).toBeInTheDocument();
  });
});
