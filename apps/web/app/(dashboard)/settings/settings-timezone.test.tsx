import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// R16-4: Business Profile shows the tenant time zone. TENANT_ADMIN edits it (PATCH /settings
// `timezone`); every lower role sees it as read-only text.

let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=profile"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn(),
  },
}));
import { apiClient } from "@/lib/api-client";

const SAVED = {
  businessName: "Acme Foods",
  email: "ops@acme.test",
  ownerName: "Jane Doe",
  phone: "5125550100",
  street: "123 Main St",
  city: "Austin",
  zip: "78701",
  timezone: "America/Chicago",
};
const HELP = "Applies to receipts and today's sales from now on";

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  (apiClient.get as jest.Mock).mockResolvedValue({ data: SAVED });
});

describe("Settings: time zone", () => {
  it("lets a tenant admin change it and PATCHes `timezone`", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    expect(screen.getByText(HELP)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "America/Denver");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({ timezone: "America/Denver" }),
      ),
    );
  });

  it("shows an operator the zone as read-only text with no control", async () => {
    mockRole = "OPERATOR";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("America/Chicago")).toBeInTheDocument();
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    expect(screen.getByText(HELP)).toBeInTheDocument();
  });
});
