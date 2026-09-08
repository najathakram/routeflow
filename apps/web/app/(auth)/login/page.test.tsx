import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import LoginPage from "./page";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// The page derives its tenant branding from two sources: the workspace implied
// by the host (`tenantSlugFromHostname(window.location.hostname)`) and
// `useTenant().branding`. jsdom's hostname is "localhost", which the real
// helper maps to null (see lib/tenant-host.test.ts), and `TenantProvider` is
// deliberately absent from `renderWithProviders` — so both are stubbed here to
// their real-world defaults (null / null, i.e. the Workspace field IS shown)
// and only the branding tests below opt into a tenant host with a logo.
let mockSubdomainSlug: string | null = null;
let mockBranding: {
  slug: string;
  businessName: string;
  primaryColor: string | null;
  logoKey: string | null;
  logoUrl: string | null;
} | null = null;

jest.mock("@/lib/tenant-host", () => ({
  ...jest.requireActual("@/lib/tenant-host"),
  tenantSlugFromHostname: () => mockSubdomainSlug,
}));

jest.mock("@/components/tenant-provider", () => ({
  ...jest.requireActual("@/components/tenant-provider"),
  useTenant: () => ({
    branding: mockBranding,
    slug: mockSubdomainSlug,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

import { apiClient } from "@/lib/api-client";

describe("LoginPage (operator)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/login");
  });

  it("shows the zod validation message and never calls the API when a required field is empty", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    // Leave everything blank and submit.
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Workspace is required")).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("logs in with the minimum valid fields and posts the expected payload", async () => {
    (apiClient.post as jest.Mock).mockResolvedValueOnce({
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: {
          id: "u1",
          username: "operator1",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantSlug: "acme",
        },
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith("/auth/login", {
        username: "operator1",
        password: "s3cret-pw",
      });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });

  // T11 (R4) — regression pin, deliberately outside the red gate: passes
  // today too (the redirect param is currently ignored) because a forced
  // password change always wins.
  it("T11: pushes /change-password when forcePasswordChange is true, even with a redirect param", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?redirect=" + encodeURIComponent("/orders/abc?tab=1"),
    );
    (apiClient.post as jest.Mock).mockResolvedValueOnce({
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: {
          id: "u1",
          username: "operator1",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: true,
          tenantSlug: "acme",
        },
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/change-password"));
  });

  // T12 (R5) — negative regression pin, deliberately outside the red gate:
  // passes today too (the redirect param is currently ignored) because an
  // off-origin redirect must never reach the router.
  it("T12: never pushes an off-origin redirect target", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?redirect=" + encodeURIComponent("https://evil.com/x"),
    );
    (apiClient.post as jest.Mock).mockResolvedValueOnce({
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: {
          id: "u1",
          username: "operator1",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantSlug: "acme",
        },
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining("evil.com"));
  });
});

// R9 — the page-level twin of AuthShell's T1c: proves /login actually SUPPLIES
// a real branding URL and alt to the shell (the shell test renders it with a
// literal "/x.png"). The e2e T5f skips on every platform host, so without this
// the logoUrl/logoAlt wiring has no automated coverage.
describe("LoginPage — tenant logo in the auth card (R9)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/login");
    mockSubdomainSlug = null;
    mockBranding = null;
  });

  afterEach(() => {
    mockSubdomainSlug = null;
    mockBranding = null;
  });

  it("renders the tenant logo inside .rf-auth-card on a tenant host, alt = business name", () => {
    mockSubdomainSlug = "acme";
    mockBranding = {
      slug: "acme",
      businessName: "Acme Distribution",
      primaryColor: null,
      logoKey: "tenants/acme/logo.png",
      logoUrl: null,
    };

    const { container } = renderWithProviders(<LoginPage />);

    const logo = container.querySelector(".rf-auth-card img");
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("src")).toContain("/public/tenants/acme/logo");
    expect(logo?.getAttribute("alt")).toBe("Acme Distribution");
  });

  it("renders no logo in .rf-auth-card on a platform host (no tenant branding)", () => {
    const { container } = renderWithProviders(<LoginPage />);

    expect(container.querySelector(".rf-auth-card img")).toBeNull();
  });
});
