import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

/**
 * Settings PR1 parity (brief section 4) at the PAGE level: the return flows and fallbacks that must
 * survive the new hub. Tab bodies are not touched by PR1; this pins what the page does around them.
 */

let mockRole = "TENANT_ADMIN";
let mockTab: string | null = null;
const replace = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
  useRouter: () => ({ push: jest.fn(), replace }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("./_components/RouteDefaultsCard", () => ({
  RouteDefaultsCard: () => <div>route-defaults-card</div>,
}));
jest.mock("./_components/BuyerOversellCard", () => ({
  BuyerOversellCard: () => <div>oversell-card</div>,
}));
jest.mock("./_components/StripeConnectCard", () => ({
  StripeConnectCard: () => <div>stripe-card</div>,
}));
jest.mock("@/lib/api/users", () => ({
  ...jest.requireActual("@/lib/api/users"),
  useUsers: () => ({ data: { data: [], meta: { total: 0 } }, isLoading: false }),
  useCreateOperator: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useUpdateUser: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useChangeUserStatus: () => ({ mutate: jest.fn(), isPending: false }),
  useResetUserPassword: () => ({ mutate: jest.fn(), isPending: false }),
  useToggleDriverPermit: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

beforeEach(() => {
  mockRole = "TENANT_ADMIN";
  mockTab = null;
  replace.mockClear();
  window.history.replaceState(null, "", "/settings");
});

describe("Settings page parity", () => {
  it("bare /settings: hub groups, then the Stripe card at #card-payments and the tier card at #tier-names", async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Invoicing & payments")).toBeInTheDocument();
    expect(screen.getByText("stripe-card")).toBeInTheDocument();
    expect(document.getElementById("card-payments")).toContainElement(
      screen.getByText("stripe-card"),
    );
    expect(document.getElementById("tier-names")).not.toBeNull();
    expect(document.getElementById("route-defaults")).not.toBeNull();
    expect(document.getElementById("out-of-stock-ordering")).not.toBeNull();
  });

  it.each(["nope", "whatsapp", "sms", "portal"])(
    "an unknown ?tab=%s still renders the hub",
    async (tab) => {
      mockTab = tab;
      renderWithProviders(<SettingsPage />);
      expect(await screen.findByText("Business & team")).toBeInTheDocument();
      expect(screen.queryByText("All settings")).not.toBeInTheDocument();
    },
  );

  it("?tab=import still redirects to the import page", async () => {
    mockTab = "import";
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings/import"));
  });

  it("?tab=regulated for a non-admin renders the hub, never the regulated screen", async () => {
    mockRole = "OPERATOR";
    mockTab = "regulated";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Business & team")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Regulated sections" })).not.toBeInTheDocument();
  });

  it("a known tab renders that one screen with the All settings back link", async () => {
    mockTab = "users";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "User management" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All settings/ })).toHaveAttribute("href", "/settings");
  });

  it("?linked=google shows the connected toast and cleans the URL", async () => {
    window.history.replaceState(null, "", "/settings?linked=google");
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Google account connected!")).toBeInTheDocument();
    expect(window.location.search).not.toContain("linked");
  });

  it("the anchor wrappers keep a scroll offset so the page title stays visible", async () => {
    renderWithProviders(<SettingsPage />);
    await screen.findByText("stripe-card");
    for (const id of ["card-payments", "tier-names", "route-defaults", "out-of-stock-ordering"]) {
      expect(document.getElementById(id)?.className).toMatch(/scroll-mt-/);
    }
  });
});
