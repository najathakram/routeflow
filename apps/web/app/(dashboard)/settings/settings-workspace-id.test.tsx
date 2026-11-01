import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import SettingsPage from "./page";

// W1 (COPY 2p): Settings > Business profile shows the Workspace ID, the slug a person types to sign in.

let mockSlug: string | null = "acme-trial";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({
    user: { id: "u1", username: "someone", role: "TENANT_ADMIN", tenantSlug: mockSlug },
  }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=profile"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
import { apiClient } from "@/lib/api-client";

beforeEach(() => {
  jest.clearAllMocks();
  mockSlug = "acme-trial";
  (apiClient.get as jest.Mock).mockResolvedValue({
    data: { businessName: "Acme Foods", email: "ops@acme.test", timezone: "America/Chicago" },
  });
});

describe("Settings: Workspace ID", () => {
  it("shows the Workspace ID with the reason it matters", async () => {
    renderWithProviders(<SettingsPage />);
    const block = await screen.findByTestId("settings-workspace-id");
    expect(block).toHaveTextContent("Workspace ID");
    expect(block).toHaveTextContent("acme-trial");
    expect(block).toHaveTextContent("You'll need it to sign in.");
  });

  it("leaves the block out when the session carries no workspace", async () => {
    mockSlug = null;
    renderWithProviders(<SettingsPage />);
    await screen.findByLabelText("Time zone");
    expect(screen.queryByTestId("settings-workspace-id")).toBeNull();
  });
});
