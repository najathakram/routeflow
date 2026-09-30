/**
 * B204 — the native token store rejects every key this app defines, and the
 * buyer boot gate turns that rejection into a permanent splash spinner.
 *
 * expo-secure-store validates keys against `/^[\w.-]+$/` and throws on reads
 * AND writes (SecureStore.ts `ensureValidKey`). Our keys are colon-namespaced
 * (`rf:op:accessToken` …), so on a device every session read/write threw. Two
 * distinct consequences, pinned separately below:
 *
 *  1. `lib/secure-key.ts#toSecureStoreKey` must respell every REAL key into
 *     the accepted alphabet — totally, idempotently, and without ever mapping
 *     two real keys onto the same spelling (a collision would silently make
 *     two sessions share storage, which is the RF-077 bug all over again).
 *  2. `buyer-session-store.initialize` must clear `isLoading` even when the
 *     underlying storage THROWS — it was the only boot store with no catch,
 *     so a storage failure left `bootstrapping` true forever and the app on
 *     the spinner. Written RED against the unhardened store first.
 *
 * Node Jest is the wrong place to exercise the real SecureStore, so the
 * validation regex is copied verbatim from
 * node_modules/expo-secure-store/build/SecureStore.js (`isValidKey`) and
 * asserted here as the contract.
 */
// Platform is the only piece of react-native these modules touch; the real
// package is Flow-typed source node Jest cannot parse.
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { toSecureStoreKey } from "../lib/secure-key";
import { OP_KEYS, DRIVER_KEYS, BUYER_KEYS, CURRENT_ROLE_KEY } from "../lib/auth-keys";
import { LAST_USERNAME_KEY } from "../lib/last-username";
import { OAUTH_STATE_KEY } from "../lib/oauth-state";

/** Verbatim from expo-secure-store's ensureValidKey. */
const SECURE_STORE_VALID_KEY = /^[\w.-]+$/;

/** Every key the app ever hands to the native secure store. */
const REAL_KEYS = [
  OP_KEYS.accessToken,
  OP_KEYS.refreshToken,
  DRIVER_KEYS.accessToken,
  DRIVER_KEYS.refreshToken,
  BUYER_KEYS.accessToken,
  BUYER_KEYS.refreshToken,
  BUYER_KEYS.activeSeller,
  CURRENT_ROLE_KEY,
  LAST_USERNAME_KEY,
  OAUTH_STATE_KEY,
  "tenantSlug",
];

describe("toSecureStoreKey (REG-B204)", () => {
  it("REG-B204: every real key maps into SecureStore's accepted alphabet", () => {
    for (const key of REAL_KEYS) {
      expect(toSecureStoreKey(key)).toMatch(SECURE_STORE_VALID_KEY);
    }
  });

  it("REG-B204: the real key set stays collision-free after mapping", () => {
    const mapped = REAL_KEYS.map(toSecureStoreKey);
    expect(new Set(mapped).size).toBe(REAL_KEYS.length);
  });

  it("REG-B204: colons become underscores, nothing else about the key changes", () => {
    expect(toSecureStoreKey("rf:op:accessToken")).toBe("rf_op_accessToken");
    expect(toSecureStoreKey("rf:oauth:pendingState")).toBe("rf_oauth_pendingState");
  });

  it("REG-B204: already-valid keys pass through untouched", () => {
    expect(toSecureStoreKey("tenantSlug")).toBe("tenantSlug");
    expect(toSecureStoreKey("a-b.c_d")).toBe("a-b.c_d");
  });

  it("REG-B204: the mapping is idempotent", () => {
    for (const key of REAL_KEYS) {
      const once = toSecureStoreKey(key);
      expect(toSecureStoreKey(once)).toBe(once);
    }
  });
});

describe("buyer-session-store boot gate (REG-B204)", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("REG-B204: initialize clears isLoading even when storage THROWS", async () => {
    jest.doMock("../lib/buyer-auth", () => ({
      getStoredBuyer: jest.fn().mockRejectedValue(new Error("Invalid key provided to SecureStore")),
      getActiveSeller: jest
        .fn()
        .mockRejectedValue(new Error("Invalid key provided to SecureStore")),
      setActiveSeller: jest.fn(),
      buyerLogout: jest.fn(),
      registerBuyerSessionExpiredHandler: jest.fn(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, see header
    const { useBuyerSessionStore } = require("../lib/buyer-session-store");

    await useBuyerSessionStore.getState().initialize();

    const state = useBuyerSessionStore.getState();
    // The whole bug: a storage failure must resolve to "signed out", never to
    // an eternal bootstrapping spinner.
    expect(state.isLoading).toBe(false);
    expect(state.buyer).toBeNull();
    expect(state.activeSeller).toBeNull();
  });

  it("REG-B204: initialize still loads a stored session on the happy path", async () => {
    const buyer = { id: "b1", email: "buyer@example.test", name: "Test Buyer" };
    const seller = { tenantSlug: "acme", businessName: "Acme Wholesale" };
    jest.doMock("../lib/buyer-auth", () => ({
      getStoredBuyer: jest.fn().mockResolvedValue(buyer),
      getActiveSeller: jest.fn().mockResolvedValue(seller),
      setActiveSeller: jest.fn(),
      buyerLogout: jest.fn(),
      registerBuyerSessionExpiredHandler: jest.fn(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh module under the mock, see header
    const { useBuyerSessionStore } = require("../lib/buyer-session-store");

    await useBuyerSessionStore.getState().initialize();

    const state = useBuyerSessionStore.getState();
    expect(state.isLoading).toBe(false);
    expect(state.buyer).toEqual(buyer);
    expect(state.activeSeller).toEqual(seller);
  });
});
