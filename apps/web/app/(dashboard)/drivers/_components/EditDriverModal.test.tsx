import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { EditDriverModal } from "./EditDriverModal";
import type { Driver } from "@/lib/api/drivers";

const driver: Driver = {
  id: "d1",
  contactName: "Jane Smith",
  phone: "512-555-0100",
  vehicleMake: "Ford",
  vehicleModel: "Transit",
  vehicleColour: "White",
  vehiclePlate: "TX-1234",
  homeAddress: null,
  homeLat: null,
  homeLng: null,
  status: "ACTIVE",
  user: {
    id: "u1",
    username: "jsmith",
    email: "jane@example.com",
    status: "ACTIVE",
    forcePasswordChange: false,
  },
  createdAt: new Date().toISOString(),
};

describe("EditDriverModal", () => {
  it("shows the zod validation message and never calls onSave when the required name is cleared", async () => {
    const onSave = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <EditDriverModal driver={driver} isOpen onClose={jest.fn()} onSave={onSave} />,
    );

    const name = screen.getByLabelText("Full Name");
    await user.clear(name);
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the edited fields", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithProviders(
      <EditDriverModal driver={driver} isOpen onClose={jest.fn()} onSave={onSave} />,
    );

    const phone = screen.getByLabelText("Phone");
    await user.clear(phone);
    await user.type(phone, "512-555-0199");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: "Jane Smith", phone: "512-555-0199" }),
      );
    });
  });
});
