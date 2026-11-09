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

const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));

let mockUser: Record<string, unknown>;
const mockUpdate = jest.fn();
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({
    data: { data: [mockUser], meta: { total: 1 } },
    isLoading: false,
  }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: mockUpdate, isPending: false, error: null }),
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

  // The request-time 409 EMAIL_TAKEN is shown as the fixed sentence for its code, never the server's text; any other
  // failure gets the generic copy. (Ratchet: the raw-message allowlist for this page drops by this one read.)
  it.each([
    [
      "EMAIL_TAKEN",
      { status: 409, data: { code: "EMAIL_TAKEN", message: "SERVER PROSE MUST NOT SHOW" } },
      "Another account already uses this address. Choose a different email.",
    ],
    [
      "EMAIL_CHANGE_ACCOUNT_INACTIVE",
      {
        status: 409,
        data: { code: "EMAIL_CHANGE_ACCOUNT_INACTIVE", message: "SERVER PROSE MUST NOT SHOW" },
      },
      "Reactivate this account, then change its email.",
    ],
    [
      "an unknown 500",
      { status: 500, data: { message: "SERVER PROSE MUST NOT SHOW" } },
      "Something went wrong on our side. Please try again.",
    ],
  ])(
    "a failed save (%s) toasts fixed copy, never the server message",
    async (_n, response, copy) => {
      mockUser = { ...baseUser, pendingEmail: null };
      mockToast.mockClear();
      mockUpdate.mockImplementation(
        async (_vars: unknown, opts: { onError: (e: Error) => void }) => {
          opts.onError(
            Object.assign(new Error("Request failed with status code " + response.status), {
              response,
            }),
          );
        },
      );
      const user = userEvent.setup();
      renderWithProviders(<SettingsPage />);

      await user.click(await screen.findByRole("button", { name: /edit user/i }));
      const dialog = within(await screen.findByRole("dialog"));
      await user.clear(dialog.getByLabelText("Email"));
      await user.type(dialog.getByLabelText("Email"), "taken@example.com");
      await user.click(dialog.getByRole("button", { name: /save changes/i }));

      await screen.findByRole("dialog");
      const toasts = mockToast.mock.calls.map((c) => c[0]);
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({
        title: "Update failed",
        description: copy,
        variant: "error",
      });
      expect(JSON.stringify(toasts)).not.toContain("SERVER PROSE");
      expect(JSON.stringify(toasts)).not.toContain("Request failed with status code");
    },
  );

  it("shows no waiting line when nothing is pending", async () => {
    mockUser = { ...baseUser, pendingEmail: null };
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: /edit user/i }));
    const dialog = within(await screen.findByRole("dialog"));

    expect(dialog.queryByTestId("pending-email-note")).not.toBeInTheDocument();
  });
});
