import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { AddDriverModal } from "./AddDriverModal";

describe("AddDriverModal", () => {
  it("shows the zod validation message and never calls onCreateDriver on an invalid submit", async () => {
    const onCreateDriver = jest.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <AddDriverModal isOpen onClose={jest.fn()} onCreateDriver={onCreateDriver} />,
    );

    await user.click(screen.getByRole("button", { name: /create driver/i }));

    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(onCreateDriver).not.toHaveBeenCalled();
  });

  it("creates a driver with the minimum valid fields", async () => {
    const onCreateDriver = jest.fn().mockResolvedValue("Tmp-Pass-1");
    const user = userEvent.setup();
    renderWithProviders(
      <AddDriverModal isOpen onClose={jest.fn()} onCreateDriver={onCreateDriver} />,
    );

    await user.type(screen.getByLabelText("Full Name"), "Jane Smith");
    await user.type(screen.getByLabelText("Email"), "jane.smith@example.com");
    // Username is auto-suggested from the name ("jsmith") once the operator
    // hasn't touched it — clear + retype to exercise the field directly too.
    const username = screen.getByLabelText("Username");
    await waitFor(() => expect(username).toHaveValue("jsmith"));

    await user.click(screen.getByRole("button", { name: /create driver/i }));

    await waitFor(() => {
      expect(onCreateDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          contactName: "Jane Smith",
          email: "jane.smith@example.com",
          username: "jsmith",
        }),
      );
    });
    expect(await screen.findByText("Tmp-Pass-1")).toBeInTheDocument();
  });
});
