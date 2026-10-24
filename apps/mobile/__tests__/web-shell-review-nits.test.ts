/**
 * W-830 review nits (#3727): pure-logic pins.
 *   1. the local buyer clear runs when ANY buyer key is stored, not only when a buyer decodes (an
 *      expired access token leaves a valid refresh token on the phone);
 *   2. the shell gate routes by the role the shell was opened with;
 *   3. a missing web URL at runtime on a store build fails closed (unavailable), never to the old
 *      native screens.
 */
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockStore.set(k, v),
  deleteItemAsync: async (k: string) => void mockStore.delete(k),
}));

import { BUYER_KEYS } from "../lib/auth-keys";
import { toSecureStoreKey } from "../lib/secure-key";
import { clearBuyerSessionLocal, getStoredBuyer, hasStoredBuyerSession } from "../lib/buyer-auth";
import {
  SHELL_ROUTE,
  shellBlocksRoute,
  shellGate,
  shouldClearNativeBuyer,
} from "../lib/web-shell/shell-routing";
import { shellMode } from "../lib/web-shell/shell-config";

const put = (key: string, v: string) => mockStore.set(toSecureStoreKey(key), v);
const has = (key: string) => mockStore.has(toSecureStoreKey(key));
const expiredBuyerJwt = () =>
  `h.${Buffer.from(
    JSON.stringify({ sub: "b1", type: "BUYER", exp: Math.floor(Date.now() / 1000) - 3600 }),
  ).toString("base64")}.s`;

describe("nit 1: the clear runs for any stored buyer key", () => {
  beforeEach(() => mockStore.clear());

  it("an expired access token decodes to no buyer, yet the refresh token is still stored", async () => {
    put(BUYER_KEYS.accessToken, expiredBuyerJwt());
    put(BUYER_KEYS.refreshToken, "refresh-token-valid");
    expect(await getStoredBuyer()).toBeNull();
    expect(await hasStoredBuyerSession()).toBe(true);
  });

  it.each([BUYER_KEYS.accessToken, BUYER_KEYS.refreshToken, BUYER_KEYS.activeSeller])(
    "%s alone counts as a stored session",
    async (key) => {
      put(key, "x");
      expect(await hasStoredBuyerSession()).toBe(true);
    },
  );

  it("an empty device has none", async () => {
    expect(await hasStoredBuyerSession()).toBe(false);
  });

  it("clearBuyerSessionLocal leaves no refresh token behind an expired access token", async () => {
    put(BUYER_KEYS.accessToken, expiredBuyerJwt());
    put(BUYER_KEYS.refreshToken, "refresh-token-valid");
    await clearBuyerSessionLocal();
    expect(has(BUYER_KEYS.refreshToken)).toBe(false);
    expect(await hasStoredBuyerSession()).toBe(false);
  });

  it("shouldClearNativeBuyer fires on a stored session with no decoded buyer, shell on only", () => {
    expect(shouldClearNativeBuyer({ shellOn: true, hasBuyer: false, hasStoredSession: true })).toBe(
      true,
    );
    expect(
      shouldClearNativeBuyer({ shellOn: false, hasBuyer: false, hasStoredSession: true }),
    ).toBe(false);
    expect(
      shouldClearNativeBuyer({ shellOn: true, hasBuyer: false, hasStoredSession: false }),
    ).toBe(false);
    expect(shouldClearNativeBuyer({ shellOn: true, hasBuyer: true })).toBe(true);
  });

  it("a stored-but-undecodable session still sends a signed-out user to the buyer shell", () => {
    const g = shellGate({
      shellOn: true,
      segments: ["index"],
      hasStaffUser: false,
      hasBuyerSession: true,
    });
    expect(g).toEqual({ handled: true, to: `${SHELL_ROUTE}?role=buyer` });
  });
});

describe("nit 2: the shell gate routes by the role the shell was opened with", () => {
  const op = { shellOn: true, hasStaffUser: true, activeRole: "operator" };

  it("an operator in a shell opened as buyer is moved to the operator shell", () => {
    expect(shellGate({ ...op, segments: ["(shell)", "web"], shellRole: "buyer" })).toEqual({
      handled: true,
      to: `${SHELL_ROUTE}?role=operator`,
    });
  });

  it("an operator in a shell opened as operator stays", () => {
    expect(shellGate({ ...op, segments: ["(shell)", "web"], shellRole: "operator" })).toEqual({
      handled: true,
      to: null,
    });
  });

  it("an operator in the shell with no role param stays (the web default is staff)", () => {
    expect(shellGate({ ...op, segments: ["(shell)", "web"] })).toEqual({
      handled: true,
      to: null,
    });
  });

  it("an operator who deep-links to customer-login lands in the OPERATOR shell and is not stuck", () => {
    const first = shellGate({ ...op, segments: ["(auth)", "customer-login"] });
    expect(first).toEqual({ handled: true, to: `${SHELL_ROUTE}?role=operator` });
    // the effect re-runs inside that shell: it stays
    expect(shellGate({ ...op, segments: ["(shell)", "web"], shellRole: "operator" }).to).toBeNull();
  });

  it("a signed-out user in either shell role stays (the web's own login)", () => {
    for (const shellRole of ["buyer", "operator"]) {
      expect(
        shellGate({
          shellOn: true,
          hasStaffUser: false,
          segments: ["(shell)", "web"],
          shellRole,
        }),
      ).toEqual({ handled: true, to: null });
    }
  });
});

describe("nit 3: a missing web URL at runtime fails closed", () => {
  const url = "https://app.example.com";
  const store = { isDev: false, isWeb: false };

  it("URL unset on a store build: unavailable, not off", () => {
    expect(shellMode({}, store)).toBe("unavailable");
    expect(shellMode({ EXPO_PUBLIC_WEB_SHELL: "on" }, store)).toBe("unavailable");
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: "   " }, store)).toBe("unavailable");
  });

  it("an unusable URL on a store build is unavailable too", () => {
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: "javascript:alert(1)" }, store)).toBe("unavailable");
  });

  it("a usable URL is on", () => {
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: url }, store)).toBe("on");
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: url, EXPO_PUBLIC_WEB_SHELL: "on" }, store)).toBe("on");
  });

  it.each(["off", "0", "false", "OFF"])("the flag %s is a deliberate off", (flag) => {
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: url, EXPO_PUBLIC_WEB_SHELL: flag }, store)).toBe("off");
    expect(shellMode({ EXPO_PUBLIC_WEB_SHELL: flag }, store)).toBe("off");
  });

  it("development builds without a URL keep the old native screens (local dev loop)", () => {
    expect(shellMode({}, { isDev: true, isWeb: false })).toBe("off");
  });

  it("the web export is native by decision (react-native-webview has no web build)", () => {
    expect(shellMode({ EXPO_PUBLIC_WEB_URL: url }, { isDev: false, isWeb: true })).toBe("off");
    expect(shellMode({}, { isDev: false, isWeb: true })).toBe("off");
  });

  it.each([
    [["(customer)", "home"]],
    [["(customer)"]],
    [["(operator)", "(tabs)", "home"]],
    [["(tenant)", "today"]],
    [["(shell)", "web"]],
    [["(auth)", "customer-login"]],
  ])("unavailable blocks the old native web-role route %j", (segments) => {
    expect(shellBlocksRoute("unavailable", segments)).toBe(true);
  });

  it.each([
    [[]],
    [["(auth)", "login"]],
    [["(auth)", "sign-in"]],
    [["(driver)", "route"]],
    [["index"]],
  ])("unavailable leaves %j alone (drivers stay native)", (segments) => {
    expect(shellBlocksRoute("unavailable", segments)).toBe(false);
  });

  it("on and off never block", () => {
    expect(shellBlocksRoute("on", ["(customer)", "home"])).toBe(false);
    expect(shellBlocksRoute("off", ["(customer)", "home"])).toBe(false);
  });
});

describe("nit 1: the buyer session store tracks a stored session and clears it for the shell", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useBuyerSessionStore } = require("../lib/buyer-session-store");

  beforeEach(() => {
    mockStore.clear();
    useBuyerSessionStore.setState({ buyer: null, activeSeller: null, hasStoredSession: false });
  });

  it("initialize flags a stored refresh token behind an expired access token", async () => {
    put(BUYER_KEYS.accessToken, expiredBuyerJwt());
    put(BUYER_KEYS.refreshToken, "refresh-token-valid");
    await useBuyerSessionStore.getState().initialize();
    const s = useBuyerSessionStore.getState();
    expect(s.buyer).toBeNull();
    expect(s.hasStoredSession).toBe(true);
  });

  it("clearForShell removes the refresh token and drops the flag, without a server call", async () => {
    put(BUYER_KEYS.accessToken, expiredBuyerJwt());
    put(BUYER_KEYS.refreshToken, "refresh-token-valid");
    await useBuyerSessionStore.getState().initialize();
    await useBuyerSessionStore.getState().clearForShell();
    expect(has(BUYER_KEYS.refreshToken)).toBe(false);
    expect(useBuyerSessionStore.getState().hasStoredSession).toBe(false);
  });
});
