import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import SettingsPage from "./page";

// Fleet-off clean UI: a tenant with no routes / delivery addon has no drivers, so Settings offers no
// DRIVER role when adding or editing users and no "Act as driver" switch on My account. Fleet-on tenants
// keep both exactly as before.
let tab = "users";
let fleet = true;
let mockMe: Record<string, unknown> = { id: "me", role: "TENANT_ADMIN" };
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`tab=${tab}`),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useFleetAccess: () => ({ fleet, loading: false }),
}));
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({
    data: {
      data: [
        {
          id: "u1",
          username: "jdoe",
          email: "jdoe@example.com",
          role: "OPERATOR",
          status: "ACTIVE",
          createdAt: new Date("2026-01-01").toISOString(),
        },
      ],
      meta: { total: 1 },
    },
    isLoading: false,
  }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useChangeUserStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useResetUserPassword: () => ({ mutate: jest.fn(), isPending: false }),
  useToggleDriverPermit: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "x", role: "TENANT_ADMIN" } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockImplementation(async () => ({ data: mockMe })),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const roleOptions = (dialog: ReturnType<typeof within>) =>
  (dialog.getByLabelText("Role") as HTMLSelectElement).options.length
    ? Array.from((dialog.getByLabelText("Role") as HTMLSelectElement).options).map((o) => o.text)
    : [];

describe("Settings — fleet-off clean UI", () => {
  beforeEach(() => {
    tab = "users";
    mockMe = { id: "me", role: "TENANT_ADMIN" };
  });

  it("fleet-OFF: Add User offers no Driver role", async () => {
    fleet = false;
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: /^add user$/i }));
    expect(roleOptions(within(await screen.findByRole("dialog")))).toEqual(["Operator"]);
  });

  it("fleet-ON (today's UI, unchanged): Add User offers Driver and Operator", async () => {
    fleet = true;
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(await screen.findByRole("button", { name: /^add user$/i }));
    expect(roleOptions(within(await screen.findByRole("dialog")))).toEqual(["Driver", "Operator"]);
  });

  it("fleet-OFF: My account has no Act as driver switch; fleet-ON keeps it", async () => {
    tab = "account";
    fleet = false;
    const { unmount } = renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Google Sign-In")).toBeInTheDocument();
    expect(screen.queryByText("Act as driver")).not.toBeInTheDocument();
    unmount();

    fleet = true;
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Act as driver")).toBeInTheDocument();
  });

  it("M4: fleet-OFF but Act as driver is already ON: the switch stays so it can be turned off", async () => {
    tab = "account";
    fleet = false;
    mockMe = { id: "me", role: "TENANT_ADMIN", canActAsDriver: true };
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Act as driver")).toBeInTheDocument();
  });
});
