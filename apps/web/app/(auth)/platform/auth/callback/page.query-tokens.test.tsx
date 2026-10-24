import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import PlatformAuthCallbackPage from "./page";

/**
 * The platform admin Google callback signs in only through the one-time `?code=`, redeemed with
 * POST /auth/google/exchange. The server sends only code, action or error here, so tokens placed
 * in the URL are ignored: no session is stored and the page shows its existing access-denied state.
 */
const push = jest.fn();
const replace = jest.fn();
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => mockSearchParams,
}));

describe("PlatformAuthCallbackPage: tokens only via the one-time code", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    localStorage.clear();
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it("tokens in the URL create no session and fall to the access-denied state", async () => {
    mockSearchParams = new URLSearchParams({
      accessToken: "url-access-token",
      refreshToken: "url-refresh-token",
      role: "SUPER_ADMIN",
    });

    renderWithProviders(<PlatformAuthCallbackPage />);

    expect(
      await screen.findByText(/not authorized for platform administration/i),
    ).toBeInTheDocument();
    expect(localStorage.getItem("superAdminToken")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("redeems the one-time code and stores the platform admin session", async () => {
    mockSearchParams = new URLSearchParams({ code: "one-time-code" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "exchanged-access-token",
        refreshToken: "exchanged-refresh-token",
        role: "SUPER_ADMIN",
      }),
    });

    renderWithProviders(<PlatformAuthCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin/dashboard"));
    expect(localStorage.getItem("superAdminToken")).toBe("exchanged-access-token");
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/google\/exchange$/);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ code: "one-time-code" }) });
  });

  it("a redeemed code for a non-admin role stores nothing and is denied", async () => {
    mockSearchParams = new URLSearchParams({ code: "one-time-code" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: "a", refreshToken: "r", role: "TENANT_ADMIN" }),
    });

    renderWithProviders(<PlatformAuthCallbackPage />);

    expect(
      await screen.findByText(/not authorized for platform administration/i),
    ).toBeInTheDocument();
    expect(localStorage.getItem("superAdminToken")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("action=linked still goes to the dashboard without a session write", () => {
    mockSearchParams = new URLSearchParams({ action: "linked" });

    renderWithProviders(<PlatformAuthCallbackPage />);

    expect(replace).toHaveBeenCalledWith("/admin/dashboard?linked=google");
    expect(localStorage.getItem("superAdminToken")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
