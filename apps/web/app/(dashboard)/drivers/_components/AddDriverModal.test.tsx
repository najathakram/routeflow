import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { AddDriverModal } from "./AddDriverModal";

let mockSlug: string | null = null;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => (mockSlug ? { user: { tenantSlug: mockSlug } } : null),
}));
beforeEach(() => {
  mockSlug = null;
});

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

    await user.type(screen.getByLabelText("Full name"), "Jane Smith");
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

  it("W1 (COPY 2s): the success view tells the admin which Workspace ID the driver signs in with", async () => {
    mockSlug = "acme-trial";
    const onCreateDriver = jest.fn().mockResolvedValue("Tmp-Pass-2");
    const user = userEvent.setup();
    renderWithProviders(
      <AddDriverModal isOpen onClose={jest.fn()} onCreateDriver={onCreateDriver} />,
    );
    await user.type(screen.getByLabelText("Full name"), "Jane Smith");
    await user.type(screen.getByLabelText("Email"), "jane.smith@example.com");
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("jsmith"));
    await user.click(screen.getByRole("button", { name: /create driver/i }));
    expect(await screen.findByText("Tmp-Pass-2")).toBeInTheDocument();
    expect(screen.getByText(/Drivers sign in with Workspace ID/)).toHaveTextContent(
      "Drivers sign in with Workspace ID acme-trial.",
    );
  });

  it("W1: with no workspace on the session the line is left out rather than shown empty", async () => {
    const onCreateDriver = jest.fn().mockResolvedValue("Tmp-Pass-3");
    const user = userEvent.setup();
    renderWithProviders(
      <AddDriverModal isOpen onClose={jest.fn()} onCreateDriver={onCreateDriver} />,
    );
    await user.type(screen.getByLabelText("Full name"), "Jane Smith");
    await user.type(screen.getByLabelText("Email"), "jane.smith@example.com");
    await waitFor(() => expect(screen.getByLabelText("Username")).toHaveValue("jsmith"));
    await user.click(screen.getByRole("button", { name: /create driver/i }));
    expect(await screen.findByText("Tmp-Pass-3")).toBeInTheDocument();
    expect(screen.queryByText(/Workspace ID/)).toBeNull();
  });
});
