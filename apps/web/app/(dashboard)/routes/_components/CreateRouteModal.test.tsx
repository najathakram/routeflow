import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CreateRouteModal } from "./CreateRouteModal";

jest.mock("@/lib/api/drivers", () => ({
  useDrivers: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
}));

const mutate = jest.fn();
jest.mock("@/lib/api/routes", () => ({
  useCreateRoute: () => ({ mutate, isPending: false }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

describe("CreateRouteModal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls the create mutation on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CreateRouteModal isOpen onClose={jest.fn()} />);

    await user.click(screen.getByRole("button", { name: /create route/i }));

    expect(await screen.findByText("Route name is required")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("creates a route with the minimum valid fields", async () => {
    mutate.mockImplementation((_payload, { onSuccess }) => onSuccess({ id: "r1" }));
    const user = userEvent.setup();
    renderWithProviders(<CreateRouteModal isOpen onClose={jest.fn()} />);

    await user.type(screen.getByLabelText("Route Name"), "North Austin Loop");
    await user.click(screen.getByRole("button", { name: /create route/i }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        { name: "North Austin Loop", driverId: undefined },
        expect.anything(),
      );
    });
  });
});
