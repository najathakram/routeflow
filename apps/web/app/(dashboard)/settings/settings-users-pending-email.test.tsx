import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import SettingsPage from "./page";

// B461 (SA-1116): the edit sheet says a login-email change is waiting while the row carries `pendingEmail`.
const searchParams = new URLSearchParams("tab=users");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

let mockUser: Record<string, unknown>;
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({
    data: { data: [mockUser], meta: { total: 1 } },
    isLoading: false,
  }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useChangeUserStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useResetUserPassword: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const baseUser = {
  id: "user-1",
  username: "jdoe",
  email: "jdoe@example.com",
  role: "OPERATOR",
  status: "ACTIVE",
  createdAt: new Date("2026-01-01").toISOString(),
};

describe("SettingsPage: Edit user, pending email", () => {
  it("shows the waiting line and the new address while a change is pending", async () => {
    mockUser = { ...baseUser, pendingEmail: "jdoe.new@example.com" };
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /edit user/i }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.getByTestId("pending-email-note")).toHaveTextContent(
      "Waiting for the new address to confirm: jdoe.new@example.com",
    );
    // the stored email stays in the field until the change confirms
    expect(dialog.getByLabelText("Email")).toHaveValue("jdoe@example.com");
  });

  it("shows no waiting line when nothing is pending", async () => {
    mockUser = { ...baseUser, pendingEmail: null };
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /edit user/i }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.queryByTestId("pending-email-note")).not.toBeInTheDocument();
  });
});
