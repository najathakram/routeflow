/**
 * Staff session-expired wiring (mirrors the buyer-side BUG-B1-1 fix):
 *
 * 1. auth-store's initialize() registers a staff session-expired handler.
 * 2. When a 401 refresh fails in api-client, the handler fires — clearing the
 *    in-memory user so the root layout redirects to the login screen instead
 *    of stranding the user on a screen whose every API call 401s.
 * 3. The original rejection still propagates (the handler never swallows it).
 * 4. The buyer-side handler registry is a separate channel — no cross-fire.
 */

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

// api-client pulls in the offline queue (AsyncStorage — native only); stub it.
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: jest.fn() }) },
}));

// buyer-auth imports expo-web-browser (native only); stub it.
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));

// auth-store imports ./auth, which drags in expo-notifications / expo-web-browser.
const mockGetStoredUser = jest.fn();
jest.mock("../lib/auth", () => ({
  login: jest.fn(),
  loginWithGoogle: jest.fn(),
  logout: jest.fn(),
  getStoredUser: (...args: unknown[]) => mockGetStoredUser(...args),
  refreshTokens: jest.fn(),
}));

import { useAuthStore } from "../lib/auth-store";
import { apiClient } from "../lib/api-client";
import { registerBuyerSessionExpiredHandler } from "../lib/buyer-auth";

const OPERATOR = {
  id: "u1",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
};

/** The single response interceptor's rejection branch, straight off axios. */
function responseRejectedHandler(): (err: unknown) => Promise<unknown> {
  const handlers = (apiClient.interceptors.response as unknown as { handlers: any[] }).handlers;
  return handlers[0]!.rejected;
}

function fake401(url = "/orders") {
  return {
    config: { url, headers: {} as Record<string, string> },
    response: { status: 401 },
  };
}

describe("staff session-expired wiring", () => {
  beforeEach(() => {
    mockGetStoredUser.mockResolvedValue(OPERATOR);
    useAuthStore.setState({ user: null, isAuthenticated: false, activeRole: null });
  });

  it("initialize() signs the stored user in and registers the expiry handler", async () => {
    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().user).toMatchObject({ id: "u1" });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().activeRole).toBe("operator");
  });

  it("a failed 401 refresh clears the in-memory user and still rejects", async () => {
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // No refresh token in (mock) storage → the refresh attempt inside the
    // interceptor fails → tokens wiped → handler fires.
    await expect(responseRejectedHandler()(fake401())).rejects.toBeTruthy();

    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().activeRole).toBeNull();
  });

  it("auth endpoints are exempt — a 401 from /auth/login must not fire the handler", async () => {
    await useAuthStore.getState().initialize();

    await expect(responseRejectedHandler()(fake401("/auth/login"))).rejects.toBeTruthy();

    // Still signed in — a wrong password on re-login must not nuke the session.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it("the buyer handler channel does not cross-fire on staff expiry", async () => {
    const buyerHandler = jest.fn();
    registerBuyerSessionExpiredHandler(buyerHandler);
    await useAuthStore.getState().initialize();

    await expect(responseRejectedHandler()(fake401())).rejects.toBeTruthy();

    expect(buyerHandler).not.toHaveBeenCalled();
  });
});
