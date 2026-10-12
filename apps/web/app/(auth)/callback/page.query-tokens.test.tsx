import * as React from "react";
import { renderWithProviders, waitFor } from "@/test-utils/render";
import { OP_KEYS, BUYER_KEYS } from "@/lib/auth-keys";
import AuthCallbackPage from "./page";

/**
 * `/callback` never creates a session from the URL. No server path redirects here; a link that
 * carries `?accessToken=&refreshToken=` stores nothing. A `?code=` is forwarded to the code-only
 * page (`/auth/google/callback`), which redeems it; anything else goes to the sign-in page.
 *
 * jsdom cannot intercept `window.location.replace` (see lib/api-client.test.ts), so the
 * observable effects asserted are storage, cookies and the router target.
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
];

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

function expectNoSession() {
  for (const key of TOKEN_KEYS) {
    expect(localStorage.getItem(key)).toBeNull();
  }
  expect(document.cookie).toBe("");
}

describe("AuthCallbackPage: no session from URL tokens", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    localStorage.clear();
    clearCookies();
    global.fetch = jest.fn() as unknown as typeof fetch;
    // jsdom logs "Not implemented: navigation" for window.location.replace.
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("tokens in the URL store nothing and the page sends the visitor to sign in", async () => {
    mockSearchParams = new URLSearchParams({
      accessToken: "url-access-token",
      refreshToken: "url-refresh-token",
      role: "TENANT_ADMIN",
      tenantSlug: "acme",
    });

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expectNoSession();
  });

  it("a code is forwarded to the code-only page and nothing is stored here", async () => {
    mockSearchParams = new URLSearchParams({
      code: "one-time-code",
      accessToken: "url-access-token",
      refreshToken: "url-refresh-token",
    });

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth/google/callback?code=one-time-code"),
    );
    expect(replace).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expectNoSession();
  });

  it("a code is forwarded encoded, never as raw query text", async () => {
    mockSearchParams = new URLSearchParams({ code: "a&accessToken=x" });

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/auth/google/callback?code=a%26accessToken%3Dx"),
    );
    expectNoSession();
  });

  it("an empty URL goes to sign in", async () => {
    mockSearchParams = new URLSearchParams();

    renderWithProviders(<AuthCallbackPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expectNoSession();
  });
});
