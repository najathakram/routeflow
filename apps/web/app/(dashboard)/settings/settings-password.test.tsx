import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// `?tab=account` mounts only MyAccountTab (and its child PasswordCard) — see
// the SECTIONS map in app/(dashboard)/settings/page.tsx.
const searchParams = new URLSearchParams("tab=account");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn((url: string) => {
      if (url === "/users/me") {
        return Promise.resolve({ data: { id: "u1", hasPassword: true, role: "CUSTOMER" } });
      }
      return Promise.resolve({ data: {} });
    }),
    post: jest.fn().mockResolvedValue({ data: { message: "ok" } }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useToggleDriverPermit: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

import { apiClient } from "@/lib/api-client";

describe("SettingsPage — My Account / Password card", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls the change-password endpoint on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /change password/i }));
    // Leave every field blank and submit.
    await user.click(screen.getByRole("button", { name: /^change password$/i }));

    expect(
      await screen.findByText(
        "Use at least 8 characters and add an uppercase letter, a lowercase letter and a number or symbol.",
      ),
    ).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalledWith("/auth/change-password", expect.anything());
  });

  it("changes the password with the minimum valid fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /change password/i }));
    // newPassword must satisfy passwordCardSchema's regex (upper + lower + a
    // digit-or-symbol) as well as the 8-char minimum.
    await user.type(screen.getByLabelText("Current password"), "old-password-1");
    await user.type(screen.getByLabelText("New password"), "NewPassword1");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPassword1");
    await user.click(screen.getByRole("button", { name: /^change password$/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith("/auth/change-password", {
        currentPassword: "old-password-1",
        newPassword: "NewPassword1",
      });
    });
  });
});

describe("SettingsPage — Password card: the checklist and what is missing", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the live checklist, names the missing lowercase letter, and maps a 400 array per rule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: /change password/i }));
    expect(screen.getByRole("list", { name: "Password requirements" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Current password"), "old-password-1");
    await user.type(screen.getByLabelText("New password"), "5C6AB7-E3B2041");
    await user.type(screen.getByLabelText("Confirm new password"), "5C6AB7-E3B2041");
    await user.click(screen.getByRole("button", { name: /^change password$/i }));
    expect(await screen.findByText("Add a lowercase letter.")).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalledWith("/auth/change-password", expect.anything());

    (apiClient.post as jest.Mock).mockRejectedValueOnce({
      response: {
        status: 400,
        data: { message: ["newPassword must be longer than or equal to 8 characters"] },
      },
    });
    await user.clear(screen.getByLabelText("New password"));
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("New password"), "NewPassword1");
    await user.type(screen.getByLabelText("Confirm new password"), "NewPassword1");
    await user.click(screen.getByRole("button", { name: /^change password$/i }));
    expect(await screen.findByText("Use at least 8 characters.")).toBeInTheDocument();
  });
});
