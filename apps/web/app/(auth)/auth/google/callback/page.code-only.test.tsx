import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { OP_KEYS, BUYER_KEYS } from "@/lib/auth-keys";
import GoogleCallbackPage from "./page";

/**
 * The API hands every browser Google sign-in to this page as a single-use `?code=`, which the
 * page redeems with POST /auth/google/exchange. Session tokens must never be accepted straight
 * from the URL: a link carrying `?accessToken=&refreshToken=` must not establish a session.
 *
 * jsdom cannot intercept `window.location.replace` (see lib/api-client.test.ts), so the
 * observable effect asserted here is what the page writes to localStorage.
 */
const push = jest.fn();
const replace = jest.fn();
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => mockSearchParams,
}));

const TOKEN_KEYS = [
  OP_KEYS.accessToken,
  OP_KEYS.refreshToken,
  BUYER_KEYS.accessToken,
  BUYER_KEYS.refreshToken,
  "accessToken",
  "refreshToken",
  "buyerAccessToken",
  "buyerRefreshToken",
];

describe("GoogleCallbackPage — tokens only via the one-time code", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    localStorage.clear();
    global.fetch = jest.fn() as unknown as typeof fetch;
    // jsdom logs "Not implemented: navigation" for window.location.replace.
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("ignores tokens placed in the URL: no session is stored and the sign-in error shows", async () => {
    mockSearchParams = new URLSearchParams({
      accessToken: "url-access-token",
      refreshToken: "url-refresh-token",
      role: "TENANT_ADMIN",
      tenantSlug: "acme",
    });

    renderWithProviders(<GoogleCallbackPage />);

    expect(await screen.findByText(/an unexpected error occurred/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    for (const key of TOKEN_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it("redeems the one-time code and stores the returned staff session", async () => {
    mockSearchParams = new URLSearchParams({ code: "one-time-code" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        accessToken: "exchanged-access-token",
        refreshToken: "exchanged-refresh-token",
        role: "TENANT_ADMIN",
        tenantSlug: "acme",
      }),
    });

    renderWithProviders(<GoogleCallbackPage />);

    await waitFor(() =>
      expect(localStorage.getItem(OP_KEYS.accessToken)).toBe("exchanged-access-token"),
    );
    expect(localStorage.getItem(OP_KEYS.refreshToken)).toBe("exchanged-refresh-token");
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/google\/exchange$/);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ code: "one-time-code" }) });
  });
});
