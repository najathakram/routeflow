import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import SettingsPage from "./page";

// `?tab=users` mounts only UserManagementTab (AddUserModal + EditUserModal
// are its children) — see the SECTIONS map in app/(dashboard)/settings/page.tsx.
const searchParams = new URLSearchParams("tab=users");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const existingUser = {
  id: "user-1",
  username: "jdoe",
  email: "jdoe@example.com",
  role: "DRIVER",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01").toISOString(),
};

const createOperatorMutateAsync = jest.fn();
const updateUserMutateAsync = jest.fn();
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({
    data: { data: [existingUser], meta: { total: 1 } },
    isLoading: false,
  }),
  useCreateOperator: () => ({
    mutateAsync: createOperatorMutateAsync,
    isPending: false,
    error: null,
  }),
  useUpdateUser: () => ({ mutateAsync: updateUserMutateAsync, isPending: false, error: null }),
  useChangeUserStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useResetUserPassword: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

describe("SettingsPage — User management: Add User", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls createOperator on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /^add user$/i }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: /^create user$/i }));

    expect(await dialog.findByText("Required")).toBeInTheDocument();
    expect(createOperatorMutateAsync).not.toHaveBeenCalled();
  });

  it("creates a user with the minimum valid fields", async () => {
    createOperatorMutateAsync.mockResolvedValue({ tempPassword: "Tmp-Pw-1" });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /^add user$/i }));
    const dialog = within(await screen.findByRole("dialog"));

    await user.type(dialog.getByLabelText("Full Name"), "New Hire");
    // Username auto-suggests from the name (first initial + full last word,
    // e.g. "jsmith" for "Jane Smith" — see AddDriverModal's identical
    // pattern) as long as the operator hasn't touched the field directly, so
    // leave it alone here rather than fighting the live suggestion.
    await waitFor(() => expect(dialog.getByLabelText("Username")).toHaveValue("nhire"));
    await user.type(dialog.getByLabelText("Email"), "newhire@example.com");
    await user.click(dialog.getByRole("button", { name: /^create user$/i }));

    await waitFor(() => {
      expect(createOperatorMutateAsync).toHaveBeenCalledWith({
        name: "New Hire",
        email: "newhire@example.com",
        username: "nhire",
      });
    });
    expect(await dialog.findByText("Tmp-Pw-1")).toBeInTheDocument();
  });
});

describe("SettingsPage — User management: Edit User", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls updateUser when the username is too short", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /edit user/i }));
    const dialog = within(await screen.findByRole("dialog"));

    const username = dialog.getByLabelText("Username");
    await user.clear(username);
    await user.type(username, "ab");
    await user.click(dialog.getByRole("button", { name: /save changes/i }));

    expect(await dialog.findByText("At least 3 characters")).toBeInTheDocument();
    expect(updateUserMutateAsync).not.toHaveBeenCalled();
  });

  it("saves the edited user", async () => {
    updateUserMutateAsync.mockImplementation((_payload, { onSuccess }) => {
      onSuccess?.();
      return Promise.resolve();
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /edit user/i }));
    const dialog = within(await screen.findByRole("dialog"));

    const email = dialog.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "jdoe-updated@example.com");
    await user.click(dialog.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(updateUserMutateAsync).toHaveBeenCalledWith(
        {
          id: "user-1",
          username: "jdoe",
          email: "jdoe-updated@example.com",
          role: "DRIVER",
        },
        expect.anything(),
      );
    });
  });
});
