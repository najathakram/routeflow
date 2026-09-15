/**
 * Train-1 driver-teardown package — PINS. GREEN pre-impl AND post-impl, so
 * these live outside the red-gate files (`session-teardown.test.ts`,
 * `pod-attach-visibility.test.ts`); the red gate excludes this file via
 * `--testPathIgnorePatterns pins`, the same convention as
 * `f11-run-cancel-skip.pins.test.ts`. Titles carry NO `REG-` token by design.
 *
 * P1 (T1, Q2) — sign-out teardown must NEVER clear the tenant store: the
 * shared-tablet branded login survives a sign-out. Today `useAuthStore.logout()`
 * never touches `lib/tenant-store` at all; after D1 (cause-ruling.md §3) the
 * new `teardownUserSession()` must still leave it alone.
 *
 * P2 (T4, REG-B111) — `app/(driver)/route/stop/[stopId]/photo.tsx` must not
 * grow payment.tsx's `startsWith("data:")` filter. It has none today; D4 must
 * not add one while converting the file:// fallback.
 *
 * The mock preamble mirrors `session-teardown.test.ts` exactly so the pin stays
 * green once `logout()` starts driving the real teardown (which touches the
 * location tracker, the query client and the 9 user-scoped stores).
 */

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: jest.fn() }) },
}));

const apiLogoutMock = jest.fn();
jest.mock("../lib/auth", () => ({
  login: jest.fn(),
  loginWithGoogle: jest.fn(),
  logout: (...args: unknown[]) => apiLogoutMock(...args),
  getStoredUser: jest.fn(),
  refreshTokens: jest.fn(),
}));

jest.mock("../lib/location-tracker", () => ({
  startLocationTracking: jest.fn(),
  stopLocationTracking: jest.fn(),
  isTracking: jest.fn(),
}));

jest.mock("../lib/query-client", () => ({
  queryClient: { cancelQueries: jest.fn(), clear: jest.fn() },
}));

// The teardown clears the persisted user-scoped blobs (REG-B136-F) and
// prefix-sweeps the staged-edit keyspace (REG-EDIT-SWEEP) — stub the native
// storage so this pin never reaches a real AsyncStorage.
const pinsGetAllKeys = jest.fn(async (): Promise<string[]> => [
  "routeflow-tenant",
  "offline-queue",
  "rf.edit-items.v1:u1:o1",
]);
const pinsMultiRemove = jest.fn(async (_keys: readonly string[]): Promise<void> => undefined);
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    getAllKeys: () => pinsGetAllKeys(),
    multiRemove: (keys: readonly string[]) => pinsMultiRemove(keys),
  },
}));

jest.mock("../store/podStore", () => ({
  POD_STORE_NAME: "routeflow-pod-store",
  usePodStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/runSettlementStore", () => ({
  RUN_SETTLEMENT_STORE_NAME: "routeflow-run-settlement",
  useRunSettlementStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/mileageStore", () => ({
  useMileageStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/routeStore", () => ({
  useRouteStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/delivery-plan-store", () => ({
  useDeliveryPlanStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/listUiStore", () => ({
  useListUiStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/productPickerStore", () => ({
  useProductPickerStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/stopCartStore", () => ({
  STOP_CART_STORE_NAME: "routeflow-stop-cart-store",
  useStopCartStore: { getState: () => ({ reset: jest.fn() }) },
}));
jest.mock("../store/returnSubmissionStore", () => ({
  RETURN_SUBMISSION_STORE_NAME: "routeflow-return-submissions",
  useReturnSubmissionStore: { getState: () => ({ reset: jest.fn() }) },
}));

// Pin: the tenant store must NEVER be touched by sign-out teardown (Q2).
const tenantClearMock = jest.fn();
jest.mock("../lib/tenant-store", () => ({
  useTenantStore: { getState: () => ({ clear: tenantClearMock }) },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { useAuthStore } from "../lib/auth-store";

const OPERATOR = {
  id: "u1",
  username: "op",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
};

describe("pin (Q2): sign-out teardown never clears the tenant store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiLogoutMock.mockResolvedValue(undefined);
    useAuthStore.setState({ user: OPERATOR as any, isAuthenticated: true, activeRole: "operator" });
  });

  it("the branded tenant survives a sign-out on a shared tablet", async () => {
    await useAuthStore.getState().logout();
    expect(tenantClearMock).not.toHaveBeenCalled();
  });

  it("the staged-edit prefix sweep stays inside its own keyspace", async () => {
    // P1 again, for the sweep added with the staged-edit snapshot: it
    // enumerates EVERY AsyncStorage key, so a mis-scoped prefix would take the
    // branded tenant and the identity-stamped offline queue with it.
    await useAuthStore.getState().logout();

    const swept = pinsMultiRemove.mock.calls.flatMap((c) => [...c[0]]);
    expect(swept).toContain("rf.edit-items.v1:u1:o1");
    expect(swept).not.toContain("routeflow-tenant");
    expect(swept).not.toContain("offline-queue");
  });
});

describe("pin (B111): photo.tsx has no independent data: filter", () => {
  it("does not itself drop file:// URIs before they reach the stop's photoUrls", () => {
    const photoSrc = readFileSync(
      join(__dirname, "..", "app", "(driver)", "route", "stop", "[stopId]", "photo.tsx"),
      "utf8",
    );
    expect(photoSrc).not.toMatch(
      /\.filter\(\s*\(?\s*p\s*\)?\s*=>\s*p\.startsWith\(\s*["'`]data:["'`]\s*\)\s*\)/,
    );
  });
});
