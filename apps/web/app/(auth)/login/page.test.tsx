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

  // B891: the Enter-in-username handler focuses getElementById("password"); the field's id is
  // explicit, so the useId default can never break it.
  it("the password field is findable by its explicit id, and its label targets it", () => {
    renderWithProviders(<LoginPage />);
    const byId = document.getElementById("password");
    expect(byId).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("Password")).toBe(byId);
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

    await user.type(screen.getByLabelText("Workspace ID"), "acme");
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

  // W-839 / SA-937 MUST 6: a driver who is also an ACTIVE buyer of this tenant is ASKED which role to use.
  describe("the role step (W-839)", () => {
    const signIn = async (user: Record<string, unknown>, me: Record<string, unknown> = {}) => {
      (apiClient.post as jest.Mock).mockResolvedValueOnce({
        data: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          user: {
            id: "u1",
            username: "sam",
            status: "ACTIVE",
            forcePasswordChange: false,
            ...user,
          },
        },
      });
      (apiClient.get as jest.Mock).mockImplementation((url: string) =>
        Promise.resolve({ data: url === "/users/me" ? me : {} }),
      );
      const u = userEvent.setup();
      renderWithProviders(<LoginPage />);
      await u.type(screen.getByLabelText("Workspace ID"), "acme");
      await u.type(screen.getByLabelText("Username or email"), "sam");
      await u.type(screen.getByLabelText("Password"), "s3cret-pw");
      await u.click(screen.getByRole("button", { name: /sign in/i }));
    };
    beforeEach(() => window.history.replaceState(null, "", "/login"));

    it("a driver who also buys goes to the role step, which will land Drive where this path lands", async () => {
      sessionStorage.clear();
      await signIn({ role: "DRIVER" }, { alsoBuyer: true });
      await waitFor(() => expect(push).toHaveBeenCalledWith("/choose-role"));
      expect(sessionStorage.getItem("rf.roleStep.landing")).toBe("/routes/my-runs");
    });

    it("a driver who does not buy keeps today's landing", async () => {
      await signIn({ role: "DRIVER" }, { alsoBuyer: false });
      await waitFor(() => expect(push).toHaveBeenCalledWith("/routes/my-runs"));
      expect(push).not.toHaveBeenCalledWith("/choose-role");
    });

    it("a non-driver is never asked and never pays for the /users/me read", async () => {
      await signIn({ role: "OPERATOR" }, { alsoBuyer: true });
      await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
      expect((apiClient.get as jest.Mock).mock.calls.some((c) => c[0] === "/users/me")).toBe(false);
    });

    it("an explicit redirect wins over the step", async () => {
      window.history.replaceState(null, "", "/login?redirect=" + encodeURIComponent("/orders/abc"));
      await signIn({ role: "DRIVER" }, { alsoBuyer: true });
      await waitFor(() => expect(push).toHaveBeenCalledWith("/orders/abc"));
      expect(push).not.toHaveBeenCalledWith("/choose-role");
    });

    it("a forced password change still goes first", async () => {
      await signIn({ role: "DRIVER", forcePasswordChange: true }, { alsoBuyer: true });
      await waitFor(() => expect(push).toHaveBeenCalledWith("/change-password"));
      expect(push).not.toHaveBeenCalledWith("/choose-role");
    });
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

    await user.type(screen.getByLabelText("Workspace ID"), "acme");
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

    await user.type(screen.getByLabelText("Workspace ID"), "acme");
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

// Owner ruling (mobile-web-proxy-redesign): /login no longer proxies phone UAs
// to the installed driver app, so it needs its own explicit link there.
describe("LoginPage — driver app link (mobile-web-proxy-redesign)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/login");
  });

  it("links to the driver app's own login screen", () => {
    renderWithProviders(<LoginPage />);

    const link = screen.getByRole("link", { name: /open the driver app/i });
    expect(link).toHaveAttribute("href", "https://routeflowmobile-production.up.railway.app/login");
  });
});

// W2 B3 (COPY.md 2k): sign-in says "Workspace ID" with a line under it, and remembers the last one
// on this device. The remembered value is its own key because sign-out clears the tenant cookie.
describe("LoginPage — Workspace ID (W2 B3)", () => {
  const signedIn = {
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
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/login");
  });

  it("labels the field Workspace ID and says where to find it", () => {
    renderWithProviders(<LoginPage />);
    const field = screen.getByLabelText("Workspace ID");
    expect(screen.getByText("It’s in your sign-up email.")).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription("It’s in your sign-up email.");
  });

  it("starts empty on a device that has signed in to nothing", () => {
    renderWithProviders(<LoginPage />);
    expect(screen.getByLabelText("Workspace ID")).toHaveValue("");
  });

  it("fills in the last Workspace ID, and the field stays editable", async () => {
    window.localStorage.setItem("rf-last-workspace", "acme-distribution");
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    const field = screen.getByLabelText("Workspace ID");
    await waitFor(() => expect(field).toHaveValue("acme-distribution"));
    await user.clear(field);
    await user.type(field, "other-co");
    expect(field).toHaveValue("other-co");
  });

  it("remembers the Workspace ID after a successful sign-in", async () => {
    (apiClient.post as jest.Mock).mockResolvedValueOnce(signedIn);
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace ID"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(window.localStorage.getItem("rf-last-workspace")).toBe("acme"));
  });

  it("does not remember a Workspace ID when sign-in fails", async () => {
    (apiClient.post as jest.Mock).mockRejectedValueOnce({
      response: { status: 401, data: { message: "Invalid username or password." } },
    });
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace ID"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "wrong-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await screen.findByText("Invalid username or password.");
    expect(window.localStorage.getItem("rf-last-workspace")).toBeNull();
  });
});
