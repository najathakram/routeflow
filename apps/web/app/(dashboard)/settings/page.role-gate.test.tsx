import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import SettingsPage from "./page";

// REG-B1013: the Settings hub (business profile, user management + Add User, email, invoicing,
// costing, integrations ...) rendered for CUSTOMER and DRIVER sessions — reachable by the nav link,
// the user menu, a bare /settings and any ?tab= deep link. A buyer or a driver may only manage their
// own account (password, sessions, Google sign-in).

let mockRole: string | undefined;
let mockTab: string | null = null;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: mockRole ? { id: "u1", username: "someone", role: mockRole } : null }),
}));

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
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

describe("SettingsPage — role gate (REG-B1013)", () => {
  beforeEach(() => {
    mockRole = undefined;
    mockTab = null;
  });

  it.each(["CUSTOMER", "DRIVER"])(
    "%s on bare /settings sees only their account, not the hub",
    async (role) => {
      mockRole = role;
      renderWithProviders(<SettingsPage />);

      expect(await screen.findByText("Google Sign-In")).toBeInTheDocument();
      expect(screen.queryByText("Business & team")).not.toBeInTheDocument();
      expect(screen.queryByText("User management")).not.toBeInTheDocument();
    },
  );

  it.each(["CUSTOMER", "DRIVER"])(
    "%s deep-linking ?tab=users never gets user management or Add User",
    async (role) => {
      mockRole = role;
      mockTab = "users";
      renderWithProviders(<SettingsPage />);

      expect(await screen.findByText("Google Sign-In")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^add user$/i })).not.toBeInTheDocument();
    },
  );

  it.each(["invoicing", "email", "costing", "profile"])(
    "a CUSTOMER deep-linking ?tab=%s gets the account screen instead",
    async (tab) => {
      mockRole = "CUSTOMER";
      mockTab = tab;
      renderWithProviders(<SettingsPage />);

      expect(await screen.findByText("Google Sign-In")).toBeInTheDocument();
      expect(screen.queryByText("All settings")).not.toBeInTheDocument();
    },
  );

  it("an operator still gets the hub (control)", async () => {
    mockRole = "OPERATOR";
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("Business & team")).toBeInTheDocument();
  });
});
