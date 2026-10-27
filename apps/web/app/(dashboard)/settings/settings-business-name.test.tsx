import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// B1231: the business name is saved through PUT /tenants/me/config/branding (TENANT_ADMIN only) and
// shown read-only to everyone else. PATCH /settings never carries businessName or email.

let mockRole = "TENANT_ADMIN";
const mockRefresh = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: mockRole } }),
}));
jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({ branding: { businessName: "Acme Wholesale" }, refresh: mockRefresh }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=profile"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn(),
  },
}));
import { apiClient } from "@/lib/api-client";

const SAVED = {
  businessName: "Acme Wholesale",
  email: "ops@acme.test",
  ownerName: "Jane Doe",
  phone: "5125550100",
  street: "123 Main St",
  city: "Austin",
  zip: "78701",
  timezone: "America/Chicago",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  (apiClient.get as jest.Mock).mockResolvedValue({ data: SAVED });
});

describe("Settings: business name (B1231)", () => {
  it("TENANT_ADMIN: a changed name goes to the branding endpoint, refreshes branding, and stays out of PATCH /settings", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Business name");
    await waitFor(() => expect(field).toHaveValue("Acme Wholesale"));
    await user.clear(field);
    await user.type(field, "Acme Foods");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(apiClient.put).toHaveBeenCalledWith("/tenants/me/config/branding", {
        businessName: "Acme Foods",
      }),
    );
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    for (const call of (apiClient.patch as jest.Mock).mock.calls) {
      expect(call[1]).not.toHaveProperty("businessName");
      expect(call[1]).not.toHaveProperty("email");
    }
  });

  it("TENANT_ADMIN: an unchanged name makes no branding call", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Business name");
    await waitFor(() => expect(field).toHaveValue("Acme Wholesale"));
    await user.clear(screen.getByLabelText("Phone"));
    await user.type(screen.getByLabelText("Phone"), "5125550199");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it("TENANT_ADMIN: a refused name save says so and never claims the profile was saved", async () => {
    (apiClient.put as jest.Mock).mockRejectedValueOnce({ response: { status: 400, data: {} } });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Business name");
    await waitFor(() => expect(field).toHaveValue("Acme Wholesale"));
    await user.clear(field);
    await user.type(field, "Acme Foods");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Couldn't save the business name")).toBeInTheDocument();
    expect(screen.queryByText("Profile saved")).toBeNull();
  });

  it("operator: the name is read-only text with a one-line explanation and no field", async () => {
    mockRole = "OPERATOR";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Acme Wholesale")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Business name" })).toBeNull();
    expect(
      screen.getByText("Only an account admin can change the business name."),
    ).toBeInTheDocument();
  });

  it("the account email is read-only for everyone and never sent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await screen.findByLabelText("Business name");
    expect(screen.queryByRole("textbox", { name: "Account email" })).toBeNull();
    expect(await screen.findByText("ops@acme.test")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Phone"));
    await user.type(screen.getByLabelText("Phone"), "5125550199");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect((apiClient.patch as jest.Mock).mock.calls[0][1]).not.toHaveProperty("email");
  });
});
