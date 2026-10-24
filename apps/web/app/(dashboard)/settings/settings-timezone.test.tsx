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

  it("a server INVALID_TIME_ZONE refusal reads as fixed copy on the field and in the toast, never the server text", async () => {
    (apiClient.patch as jest.Mock).mockRejectedValueOnce({
      response: { status: 400, data: { code: "INVALID_TIME_ZONE", message: "RAW SERVER TEXT" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    await user.clear(field);
    await user.type(field, "America/Denver");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(
      await screen.findAllByText("That isn't a valid time zone. Pick one from the list."),
    ).not.toHaveLength(0);
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.queryByText("Failed to save settings")).toBeNull();
  });

  it("a 403 (a role the server does not allow) reads as a plain permission line, not a generic failure", async () => {
    (apiClient.patch as jest.Mock).mockRejectedValueOnce({ response: { status: 403, data: {} } });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    await user.clear(field);
    await user.type(field, "America/Denver");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(
      await screen.findByText("Only an account admin can change the time zone."),
    ).toBeInTheDocument();
  });

  it("canonicalises the spelling when the field loses focus", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    await user.clear(field);
    await user.type(field, "america/denver");
    await user.tab();
    expect(field).toHaveValue("America/Denver");
  });

  it("an empty zone reads the same 'Choose a time zone.' line as the create page", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Choose a time zone.")).toBeInTheDocument();
  });

  it("shows an operator the zone as read-only text with no control", async () => {
    mockRole = "OPERATOR";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("America/Chicago")).toBeInTheDocument();
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    expect(screen.getByText(HELP)).toBeInTheDocument();
  });

  const patchBody = () =>
    (apiClient.patch as jest.Mock).mock.calls[0]![1] as Record<string, unknown>;

  it("an operator's save never carries a timezone key", async () => {
    mockRole = "OPERATOR";
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await screen.findByText("America/Chicago");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(patchBody()).not.toHaveProperty("timezone");
  });

  it("a stored zone the browser rejects never blocks an operator's save", async () => {
    mockRole = "OPERATOR";
    (apiClient.get as jest.Mock).mockResolvedValue({ data: { ...SAVED, timezone: "Not/AZone" } });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await screen.findByText("Not/AZone");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(patchBody()).not.toHaveProperty("timezone");
  });

  it("an admin who edits only the address does not send timezone", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("Time zone")).toHaveValue("America/Chicago"));
    await user.clear(screen.getByLabelText("City"));
    await user.type(screen.getByLabelText("City"), "Dallas");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalled());
    expect(patchBody()).toMatchObject({ city: "Dallas" });
    expect(patchBody()).not.toHaveProperty("timezone");
  });

  it("an admin who clears the zone gets a required error and nothing is sent", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    await waitFor(() => expect(field).toHaveValue("America/Chicago"));
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText("Choose a time zone.")).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("links the help copy to the control, and the read-only view is a label/value pair", async () => {
    const { unmount } = renderWithProviders(<SettingsPage />);
    const field = await screen.findByLabelText("Time zone");
    expect(field).toHaveAccessibleDescription(HELP);
    unmount();
    mockRole = "OPERATOR";
    renderWithProviders(<SettingsPage />);
    const value = await screen.findByText("America/Chicago");
    expect(value.tagName).toBe("DD");
    expect(value.previousElementSibling).toHaveTextContent("Time zone");
  });
});
