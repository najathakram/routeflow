/**
 * T1 (bug-test-plan.md) — REG-B150 / REG-B140: sign-out teardown.
 *
 * Design of record: cause-ruling.md §3 D1. `useAuthStore.logout()` must call
 * ONE teardown function (`lib/session-teardown.ts#teardownUserSession`)
 * BEFORE `apiLogout()` (tokens still valid): stop background GPS for BOTH
 * realms, mark the offline queue's owner, `queryClient.cancelQueries()` then
 * `.clear()`, and reset the 8 user-scoped stores (stopCartStore added to the
 * original 7) — the tenant store is never touched (Q2, shared-tablet
 * branded login).
 *
 * Mobile Jest is pure-logic only (jest.config.js testMatch) — this drives the
 * REAL `useAuthStore.logout()` with every native/store dependency mocked, the
 * same shape session-expired-wiring.test.ts already uses for this exact
 * store. `lib/session-teardown.ts` and `lib/query-client.ts` are
 * signature-only stubs (see their own file headers) written so these imports
 * resolve — `teardownUserSession` currently does nothing, so `logout()`
 * literally cannot reach any of the mocks below yet, which is the failure
 * this file pins.
 */

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

// api-client pulls in the offline queue (AsyncStorage — native only); stub it
// exactly as session-expired-wiring.test.ts does.
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: jest.fn() }) },
}));

// auth-store imports ./auth, which drags in expo-notifications / expo-web-browser.
const apiLogoutMock = jest.fn();
const getStoredUserMock = jest.fn();
jest.mock("../lib/auth", () => ({
  login: jest.fn(),
  loginWithGoogle: jest.fn(),
  logout: (...args: unknown[]) => apiLogoutMock(...args),
  getStoredUser: (...args: unknown[]) => getStoredUserMock(...args),
  refreshTokens: jest.fn(),
}));

// initialize() registers the staff session-expired callback through api-client
// — capture it so the OTHER teardown caller can be driven directly.
let sessionExpiredHandler: (() => void) | null = null;
jest.mock("../lib/api-client", () => ({
  registerStaffSessionExpiredHandler: (fn: () => void) => {
    sessionExpiredHandler = fn;
  },
}));

// The teardown stays REAL by default (the spy passes through), so every pin
// below keeps observing its actual side effects; the spy exists so the
// session-expired caller and a REJECTING teardown can be pinned directly.
const teardownSpy = jest.fn();
jest.mock("../lib/session-teardown", () => ({
  teardownUserSession: (...args: unknown[]) => teardownSpy(...args),
}));
const realTeardownUserSession = (
  jest.requireActual("../lib/session-teardown") as typeof import("../lib/session-teardown")
).teardownUserSession;

const stopLocationTracking = jest.fn();
jest.mock("../lib/location-tracker", () => ({
  startLocationTracking: jest.fn(),
  stopLocationTracking: (...args: unknown[]) => stopLocationTracking(...args),
  isTracking: jest.fn(),
}));

const cancelQueriesMock = jest.fn();
const clearQueryCacheMock = jest.fn();
jest.mock("../lib/query-client", () => ({
  queryClient: {
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
    clear: (...args: unknown[]) => clearQueryCacheMock(...args),
  },
}));

// The teardown now clears the two PERSISTED user-scoped blobs through
// lib/user-scoped-storage.ts (REG-B136-F), which is kept REAL so the key it
// addresses is observable — only the native storage under it is mocked, the
// same shape offline-queue-identity.test.ts uses.
const removeItemMock = jest.fn();
// The staged-edit snapshot is a KEYSPACE (one key per order), so the teardown
// also enumerates and prefix-sweeps — mock those two calls as well.
const getAllKeysMock = jest.fn();
const multiRemoveMock = jest.fn();
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: (...args: unknown[]) => removeItemMock(...args),
    getAllKeys: (...args: unknown[]) => getAllKeysMock(...args),
    multiRemove: (...args: unknown[]) => multiRemoveMock(...args),
  },
}));

const podStoreReset = jest.fn();
jest.mock("../store/podStore", () => ({
  POD_STORE_NAME: "routeflow-pod-store",
  usePodStore: { getState: () => ({ reset: podStoreReset }) },
}));
const runSettlementStoreReset = jest.fn();
jest.mock("../store/runSettlementStore", () => ({
  RUN_SETTLEMENT_STORE_NAME: "routeflow-run-settlement",
  useRunSettlementStore: { getState: () => ({ reset: runSettlementStoreReset }) },
}));
const mileageStoreReset = jest.fn();
jest.mock("../store/mileageStore", () => ({
  useMileageStore: { getState: () => ({ reset: mileageStoreReset }) },
}));
const routeStoreReset = jest.fn();
jest.mock("../store/routeStore", () => ({
  useRouteStore: { getState: () => ({ reset: routeStoreReset }) },
}));
const deliveryPlanStoreReset = jest.fn();
jest.mock("../store/delivery-plan-store", () => ({
  useDeliveryPlanStore: { getState: () => ({ reset: deliveryPlanStoreReset }) },
}));
const listUiStoreReset = jest.fn();
jest.mock("../store/listUiStore", () => ({
  useListUiStore: { getState: () => ({ reset: listUiStoreReset }) },
}));
const productPickerStoreReset = jest.fn();
jest.mock("../store/productPickerStore", () => ({
  useProductPickerStore: { getState: () => ({ reset: productPickerStoreReset }) },
}));
const stopCartStoreReset = jest.fn();
jest.mock("../store/stopCartStore", () => ({
  STOP_CART_STORE_NAME: "routeflow-stop-cart-store",
  useStopCartStore: { getState: () => ({ reset: stopCartStoreReset }) },
}));

// The Q2 pin — "sign-out teardown NEVER clears the tenant store" — is green
// before AND after the fix, so it does not belong in this red-gate file: it
// lives in `session-teardown.pins.test.ts` (same mock preamble), which the red
// gate excludes via --testPathIgnorePatterns pins.

import { readFileSync } from "fs";
import { join } from "path";
import { useAuthStore } from "../lib/auth-store";
import type { TeardownOptions } from "../lib/session-teardown";
import { clearUserScopedStorage, userScopedStorageKeyFor } from "../lib/user-scoped-storage";
import { editItemsSnapshotKey } from "../lib/edit-items-draft";

const OPERATOR = {
  id: "u1",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
};

const USER_SCOPED_RESETS: Array<[string, jest.Mock]> = [
  ["podStore", podStoreReset],
  ["runSettlementStore", runSettlementStoreReset],
  ["mileageStore", mileageStoreReset],
  ["routeStore", routeStoreReset],
  ["delivery-plan-store", deliveryPlanStoreReset],
  ["listUiStore", listUiStoreReset],
  ["productPickerStore", productPickerStoreReset],
  ["stopCartStore", stopCartStoreReset],
];

describe("useAuthStore.logout() teardown (T1, REG-B150 / REG-B140)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiLogoutMock.mockResolvedValue(undefined);
    teardownSpy.mockImplementation((options?: TeardownOptions) => realTeardownUserSession(options));
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });
  });

  it("REG-B150-A: stops background location BEFORE apiLogout runs — TODAY: stop is never called (0 calls)", async () => {
    const order: string[] = [];
    stopLocationTracking.mockImplementation(() => {
      order.push("stop");
      return Promise.resolve();
    });
    apiLogoutMock.mockImplementation(() => {
      order.push("apiLogout");
      return Promise.resolve();
    });

    await useAuthStore.getState().logout();

    expect(order).toEqual(["stop", "apiLogout"]);
  });

  it("REG-B150-C: the OPERATOR realm stops tracking exactly once — TODAY: stop is never called (0 calls)", async () => {
    // Behavioral counterpart to the REG-B150-B source-text pin. The operator
    // realm starts background GPS in (operator)/(tabs)/home.tsx and had NO stop
    // site at all (cause-ruling.md §1), so the shared teardown must not be
    // gated behind role === "DRIVER" / activeRole === "driver". The realm is
    // set here explicitly rather than inherited from beforeEach, so this stays
    // an operator-realm proof no matter what the shared fixture becomes, and
    // "exactly once" pins that the single shared call site is the only one.
    const order: string[] = [];
    stopLocationTracking.mockImplementation(() => {
      order.push("stop");
      return Promise.resolve();
    });
    apiLogoutMock.mockImplementation(() => {
      order.push("apiLogout");
      return Promise.resolve();
    });
    useAuthStore.setState({
      user: { ...OPERATOR, role: "OPERATOR" } as any,
      isAuthenticated: true,
      activeRole: "operator",
    });

    await useAuthStore.getState().logout();

    expect(stopLocationTracking).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["stop", "apiLogout"]);
  });

  it("REG-B140-A: cancels queries THEN clears the cache — TODAY: 0 calls", async () => {
    const order: string[] = [];
    cancelQueriesMock.mockImplementation(() => {
      order.push("cancelQueries");
      return Promise.resolve();
    });
    clearQueryCacheMock.mockImplementation(() => {
      order.push("clear");
    });

    await useAuthStore.getState().logout();

    expect(order).toEqual(["cancelQueries", "clear"]);
  });

  it.each(USER_SCOPED_RESETS)(
    "REG-B140-B: resets the %s store on logout — TODAY: the store has no reset() at all",
    async (name, resetMock) => {
      // The mock above supplies `reset` — so first pin that the REAL store
      // actually exposes one, otherwise an implementation that calls
      // `useXStore.getState().reset()` would turn this green while throwing
      // TypeError in production. TODAY: none of the 7 stores has a reset.
      // Two DISTINCT matches are required: the interface member on its own
      // (`reset: () => void;`) must not satisfy this check, because
      // `resetIfPresent` in lib/session-teardown.ts calls `reset?.()` — a
      // declared-but-unimplemented reset silently no-ops and leaves the
      // previous user's data in the store while every case here stays green.
      const storeSrc = readFileSync(join(__dirname, "..", "store", `${name}.ts`), "utf8");
      expect(storeSrc).toMatch(/\breset\s*:\s*\(\s*\)\s*=>\s*void\s*;/);
      expect(storeSrc).toMatch(/\breset\s*:\s*\(\s*\)\s*=>\s*(?:set\s*\(|\{)/);

      await useAuthStore.getState().logout();
      expect(resetMock).toHaveBeenCalledTimes(1);
    },
  );
});

/**
 * The session-expired path is the SECOND caller of the shared teardown
 * (lib/auth-store.ts, registerStaffSessionExpiredHandler callback), and a
 * teardown that rejects must never strand the user signed in.
 */
describe("second teardown caller + failure path (T1, REG-B150-D / REG-B140-C)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionExpiredHandler = null;
    apiLogoutMock.mockResolvedValue(undefined);
    getStoredUserMock.mockResolvedValue(OPERATOR);
    teardownSpy.mockResolvedValue(undefined);
    useAuthStore.setState({ user: null, isAuthenticated: false, activeRole: null });
  });

  it("REG-B150-D: the registered session-expired handler runs the SHARED teardown", async () => {
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(typeof sessionExpiredHandler).toBe("function");

    sessionExpiredHandler!();
    await Promise.resolve();

    expect(teardownSpy).toHaveBeenCalledWith({ reason: "session-expired", userId: "u1" });
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("REG-B140-C: a REJECTING teardown still completes sign-out (apiLogout + cleared user)", async () => {
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });
    teardownSpy.mockRejectedValue(new Error("teardown blew up"));

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

/**
 * REG-B150-B — the operator realm starts background GPS too (home.tsx) but
 * today has NO stop site anywhere (cause-ruling.md §1). D1's fix is for the
 * ONE shared teardown function to stop tracking unconditionally — not gated
 * behind a driver-only role check — so both the driver and operator sign-out
 * paths (which both call the same `useAuthStore.logout()`, see
 * app/(driver)/driver-profile.tsx and app/(operator)/profile.tsx) are
 * covered by the single call proven above. Source-text pin on the shared
 * function itself, comment-stripped so a mention in prose can't satisfy it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("REG-B150-B: the shared teardown stops tracking for BOTH realms (source-text)", () => {
  const teardownSrc = stripComments(
    readFileSync(join(__dirname, "..", "lib", "session-teardown.ts"), "utf8"),
  );

  it("calls stopLocationTracking with no role/realm gate around it — TODAY: no stop site at all", () => {
    expect(teardownSrc).toMatch(/stopLocationTracking\s*\(/);
    const callWindow = (teardownSrc.match(/[\s\S]{0,300}stopLocationTracking\s*\(/) ?? [""])[0];
    expect(callWindow).not.toMatch(/role\s*===\s*["']DRIVER["']|activeRole\s*===\s*["']driver["']/);
  });
});

/**
 * REG-B136-F — the persisted sign-out clear must land in the OUTGOING USER's
 * bucket, not `anon`.
 *
 * `reset()` on a persisted store kicks off a zustand-persist write that is
 * fire-and-forget and resolves its own AsyncStorage key one async hop later
 * (lib/user-scoped-storage.ts `getItem`/`setItem` both `await getStoredUser()`
 * first). By then `apiLogout()` — or, on the session-expired path, the
 * api-client's own token wipe, which has ALWAYS already happened — may have
 * deleted the tokens, so the write lands in `routeflow-pod-store:anon` and
 * leaves `routeflow-pod-store:<userId>` untouched: the same user signing back
 * in rehydrates the captures the teardown was supposed to have cleared.
 *
 * The fix resolves the identity FIRST and deletes the two persisted keys
 * outright with it, so a late persist write can only ever re-create the reset
 * (empty) state.
 */
describe("REG-B136-F: sign-out clears the persisted blobs by pre-resolved user id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiLogoutMock.mockResolvedValue(undefined);
    teardownSpy.mockImplementation((options?: TeardownOptions) => realTeardownUserSession(options));
  });

  it("userScopedStorageKeyFor is pure — a known id, and the anon fallback", () => {
    expect(userScopedStorageKeyFor("routeflow-pod-store", "u-1")).toBe("routeflow-pod-store:u-1");
    expect(userScopedStorageKeyFor("routeflow-pod-store", null)).toBe("routeflow-pod-store:anon");
  });

  it("clearUserScopedStorage removes exactly that key", async () => {
    await clearUserScopedStorage("routeflow-pod-store", "u-1");
    expect(removeItemMock).toHaveBeenCalledWith("routeflow-pod-store:u-1");
  });

  it("logout deletes all THREE persisted keys under the signed-in user's id (driver-durability lane added stopCartStore)", async () => {
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });

    await useAuthStore.getState().logout();

    expect(removeItemMock.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        "routeflow-pod-store:u1",
        "routeflow-run-settlement:u1",
        "routeflow-stop-cart-store:u1",
      ]),
    );
    // Never the anon bucket — that is the bug this pins.
    expect(removeItemMock.mock.calls.map((c) => c[0])).not.toContain("routeflow-pod-store:anon");
  });
});

/**
 * FINDING 2 (RULINGS R1) — the order-item editor parks the operator's staged
 * edit at `rf.edit-items.v1:<userId>:<orderId>`. That is one key PER ORDER, so
 * it cannot be addressed by a `clearUserScopedStorage(NAME, userId)` call and
 * sign-out never cleared it: the next operator to sign in on the same device
 * was offered the previous one's staged edit for restore. Teardown now sweeps
 * the outgoing user's whole prefix.
 */
describe("REG-EDIT-SWEEP: sign-out sweeps the staged-edit KEYSPACE", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiLogoutMock.mockResolvedValue(undefined);
    teardownSpy.mockImplementation((options?: TeardownOptions) => realTeardownUserSession(options));
    getAllKeysMock.mockResolvedValue([]);
    multiRemoveMock.mockResolvedValue(undefined);
  });

  it("REG-EDIT-SWEEP-B: logout removes EVERY staged order edit of the outgoing user, and no one else's — AND the anon bucket (F1)", async () => {
    const mine = [editItemsSnapshotKey("o1", "u1"), editItemsSnapshotKey("o2", "u1")];
    const anon = [editItemsSnapshotKey("o4", null)];
    const theirs = [editItemsSnapshotKey("o1", "u2"), editItemsSnapshotKey("o3", "u10")];
    getAllKeysMock.mockResolvedValue([
      ...mine,
      ...anon,
      ...theirs,
      "routeflow-pod-store:u1",
      "tokens",
    ]);

    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });
    await useAuthStore.getState().logout();

    expect(getAllKeysMock).toHaveBeenCalled();
    // Two separate sweeps: the outgoing user's own prefix, then the anon
    // bucket belt-and-braces (F1) — one multiRemove call per non-empty match.
    expect(multiRemoveMock).toHaveBeenCalledTimes(2);
    const swept = multiRemoveMock.mock.calls.flatMap((call) => call[0] as string[]);
    expect([...swept].sort()).toEqual([...mine, ...anon].sort());
    // "u1" must not sweep "u10" (the trailing separator), another user, or an
    // unrelated key.
    for (const key of [...theirs, "routeflow-pod-store:u1", "tokens"]) {
      expect(swept).not.toContain(key);
    }
  });

  it("REG-MSCAN-A4-anon: teardown sweeps the anon bucket even when the outgoing user has nothing staged", async () => {
    const anonOnly = [editItemsSnapshotKey("o9", null)];
    getAllKeysMock.mockResolvedValue([...anonOnly, "tokens"]);

    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });
    await useAuthStore.getState().logout();

    expect(multiRemoveMock).toHaveBeenCalledTimes(1);
    expect(multiRemoveMock.mock.calls[0][0]).toEqual(anonOnly);
  });

  it("REG-EDIT-SWEEP-C: nothing to sweep issues no multiRemove", async () => {
    getAllKeysMock.mockResolvedValue(["tokens", "routeflow-pod-store:u1"]);
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });

    await useAuthStore.getState().logout();

    expect(multiRemoveMock).not.toHaveBeenCalled();
  });

  it("REG-EDIT-SWEEP-D: a storage failure during the sweep never breaks sign-out", async () => {
    getAllKeysMock.mockRejectedValue(new Error("storage unavailable"));
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();
    expect(apiLogoutMock).toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

/**
 * REG-B136-F (source pins) — the ordering the behavioral cases above rely on.
 * Comment-stripped so a mention in prose cannot satisfy either check.
 */
describe("REG-B136-F: identity is resolved before anything can delete the tokens", () => {
  const teardownSrc = stripComments(
    readFileSync(join(__dirname, "..", "lib", "session-teardown.ts"), "utf8"),
  );
  const authStoreSrc = stripComments(
    readFileSync(join(__dirname, "..", "lib", "auth-store.ts"), "utf8"),
  );

  it("session-teardown resolves options.userId / getStoredUser BEFORE stopLocationTracking", () => {
    const identityAt = teardownSrc.search(/options\.userId|getStoredUser\s*\(/);
    const stopAt = teardownSrc.search(/stopLocationTracking\s*\(\s*\)/);
    expect(identityAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(stopAt);
  });

  it("session-teardown clears all THREE persisted stores after the resets", () => {
    const clears = teardownSrc.match(/clearUserScopedStorage\s*\(/g) ?? [];
    expect(clears).toHaveLength(3);
    const lastResetAt = teardownSrc.lastIndexOf("resetIfPresent(use");
    expect(lastResetAt).toBeGreaterThan(-1);
    expect(teardownSrc.search(/clearUserScopedStorage\s*\(/)).toBeGreaterThan(lastResetAt);
  });

  it("REG-EDIT-SWEEP-E: the prefix sweep runs AFTER the per-store clears and is wrapped", () => {
    // The sweep must not be able to throw a sign-out down — unlike step (5)'s
    // removes, it depends on `getAllKeys`, which an older native module (or an
    // older test mock) may not expose at all.
    const sweepAt = teardownSrc.indexOf("clearStorageByPrefix(editItemsSnapshotUserPrefix(");
    expect(sweepAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(teardownSrc.lastIndexOf("clearUserScopedStorage("));
    const helperAt = teardownSrc.indexOf("async function clearStorageByPrefix");
    expect(helperAt).toBeGreaterThan(-1);
    const helper = teardownSrc.slice(helperAt, helperAt + 600);
    expect(helper).toContain("AsyncStorage.getAllKeys()");
    expect(helper).toContain("AsyncStorage.multiRemove(");
    expect(helper).toContain("} catch {");
    // The prefix comes from the editor's own key helper — a second hand-rolled
    // literal here is how a sweep silently stops matching.
    expect(teardownSrc).toContain("editItemsSnapshotUserPrefix");
    expect(teardownSrc).not.toContain("rf.edit-items");
  });

  it("all three auth-store call sites (logout, session-expired, cross-tab/REG-B140-D) hand the teardown a userId", () => {
    const callSites = authStoreSrc.match(/teardownUserSession\(\{[\s\S]*?\}\)/g) ?? [];
    expect(callSites).toHaveLength(3);
    for (const site of callSites) expect(site).toMatch(/userId\s*:/);
  });
});

/**
 * REG-B140-D — cross-tab logout (web build). Before this fix,
 * `installCrossTabLogoutListener`'s "storage" handler only dropped the
 * in-memory user; it never ran the shared teardown, so tab B kept the prior
 * user's GPS tracking, query cache, and the 8 user-scoped stores alive after
 * tab A signed out elsewhere. This describe gets its own fresh module graph
 * (`jest.resetModules()` + a dynamic import) because `installCrossTabLogoutListener`
 * is a module-level, install-once singleton gated on `Platform.OS === "web"`
 * and a real `window` — neither of which the rest of this file (OS "ios", no
 * window) exercises. `react-native` is re-mocked to "web" via `jest.doMock`
 * for just this block; every other static mock in this file (session-teardown,
 * the 8 stores, api-client, auth, etc.) survives `resetModules()` unchanged.
 */
describe("REG-B140-D: cross-tab logout tears down (web build)", () => {
  let storageHandler: ((e: { key: string | null; newValue: string | null }) => void) | null = null;
  let savedWindow: unknown;
  let authStore: (typeof import("../lib/auth-store"))["useAuthStore"];
  let opAccessTokenKey: string;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    teardownSpy.mockResolvedValue(undefined);
    getStoredUserMock.mockResolvedValue(null);
    apiLogoutMock.mockResolvedValue(undefined);

    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }));

    storageHandler = null;
    savedWindow = (global as Record<string, unknown>).window;
    (global as Record<string, unknown>).window = {
      addEventListener: (event: string, handler: typeof storageHandler) => {
        if (event === "storage") storageHandler = handler;
      },
    };

    const authKeys = (await import("../lib/auth-keys")) as typeof import("../lib/auth-keys");
    opAccessTokenKey = authKeys.OP_KEYS.accessToken;

    const authStoreModule =
      (await import("../lib/auth-store")) as typeof import("../lib/auth-store");
    authStore = authStoreModule.useAuthStore;

    await authStore.getState().initialize();
    authStore.setState({
      user: { ...OPERATOR, id: "u-tab-a" } as any,
      isAuthenticated: true,
      activeRole: "operator",
    });
  });

  afterEach(() => {
    (global as Record<string, unknown>).window = savedWindow;
  });

  it("installs the storage listener on a web build", () => {
    expect(typeof storageHandler).toBe("function");
  });

  it("runs the shared teardown for this tab's user BEFORE clearing the in-memory user — TODAY: teardown never called", () => {
    storageHandler!({ key: opAccessTokenKey, newValue: null });

    expect(teardownSpy).toHaveBeenCalledWith({ reason: "cross-tab", userId: "u-tab-a" });
    expect(authStore.getState().user).toBeNull();
    expect(authStore.getState().isAuthenticated).toBe(false);
  });

  it("ignores a storage event for an unrelated key or a non-clear write", () => {
    storageHandler!({ key: "some-other-key", newValue: null });
    storageHandler!({ key: opAccessTokenKey, newValue: "still-set" });

    expect(teardownSpy).not.toHaveBeenCalled();
    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("never calls apiLogout — the other tab already told the server", () => {
    storageHandler!({ key: opAccessTokenKey, newValue: null });

    expect(apiLogoutMock).not.toHaveBeenCalled();
  });
});
