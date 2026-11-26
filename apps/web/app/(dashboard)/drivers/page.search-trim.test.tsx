import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import DriversPage from "./page";

/**
 * R-137 (UX audit F49): the Drivers list filters in the browser on the search box's own text, so the trim in
 * `useUrlSearch` (which covers the lists that query the server with the debounced term) did not reach it. A space in
 * front of the name matched nobody.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/drivers",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
jest.mock("./_components/AddDriverModal", () => ({ AddDriverModal: () => null }));
jest.mock("./_components/EditDriverModal", () => ({ EditDriverModal: () => null }));

const driver = (id: string, contactName: string) => ({
  id,
  contactName,
  phone: `555-010${id}`,
  status: "ACTIVE",
  vehicleMake: null,
  vehicleModel: null,
  vehicleColour: null,
  vehiclePlate: null,
  user: { username: `driver${id}` },
});
jest.mock("@/lib/api/drivers", () => ({
  ...jest.requireActual("@/lib/api/drivers"),
  useDrivers: () => ({
    data: { data: [driver("1", "Acme Alice"), driver("2", "Bolt Bob")] },
    isLoading: false,
    isError: false,
  }),
  useCreateDriver: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateDriver: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteDriver: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => window.history.replaceState(null, "", "/drivers"));

describe("Drivers list search", () => {
  it("a space in front of the name still finds the driver", async () => {
    renderWithProviders(<DriversPage />);
    await userEvent.setup().type(screen.getByRole("searchbox"), " acme");
    expect(screen.getAllByText("Acme Alice").length).toBeGreaterThan(0);
    expect(screen.queryByText("Bolt Bob")).not.toBeInTheDocument();
    expect(screen.queryByText("No drivers match your search.")).not.toBeInTheDocument();
  });

  it("spaces on both ends, same result; a space between two words is kept", async () => {
    renderWithProviders(<DriversPage />);
    await userEvent.setup().type(screen.getByRole("searchbox"), "  acme alice ");
    expect(screen.getAllByText("Acme Alice").length).toBeGreaterThan(0);
    expect(screen.queryByText("Bolt Bob")).not.toBeInTheDocument();
  });
});
