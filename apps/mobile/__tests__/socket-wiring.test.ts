/**
 * RF-002 Socket wiring smoke tests
 *
 * Verifies that:
 * 1. useSocket reads the operator token from the role-namespaced key (rf:op:accessToken)
 * 2. useSocket reads the driver token from the role-namespaced key (rf:driver:accessToken)
 * 3. useBuyerSocket reads the buyer token from the role-namespaced key (rf:buyer:accessToken)
 *    (not the legacy "buyerAccessToken" key that was migrated away in NEW-m2-1/RF-077)
 * 4. socket.io io() is called with the token and the correct API URL
 *
 * These are pure unit tests — no React renderer needed. The "connect" logic
 * is extracted from the hooks via spying on `io` from socket.io-client.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock socket.io-client before any import that uses it
const mockSocketOn = jest.fn();
const mockSocketDisconnect = jest.fn();
const mockIo = jest.fn(() => ({
  on: mockSocketOn,
  disconnect: mockSocketDisconnect,
}));

jest.mock("socket.io-client", () => ({
  io: mockIo,
}));

// Mock react-native: default to web platform so we test the localStorage path
jest.mock("react-native", () => ({
  Platform: { OS: "web" },
}));

// Mock @tanstack/react-query
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

// Mock zustand stores — set up later per test
const mockAuthStore = { user: null as null | { role: string; id: string } };
const mockBuyerStore = { buyer: null as null | { id: string } };

jest.mock("../lib/auth-store", () => ({
  useAuthStore: () => mockAuthStore,
}));

jest.mock("../lib/buyer-session-store", () => ({
  useBuyerSessionStore: () => mockBuyerStore,
}));

// Mock useRef + useEffect to run synchronously in tests
// We'll call the hook manually instead, extracting logic.
jest.mock("react", () => {
  const actual = jest.requireActual("react") as Record<string, unknown>;
  return {
    ...actual,
    useEffect: (fn: () => unknown) => fn(),           // run immediately
    useRef: (init: unknown) => ({ current: init }),   // simple ref
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fake localStorage for the web path
const localStorageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, val: string) => { localStorageStore[key] = val; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
};
Object.defineProperty(global, "localStorage", { value: mockLocalStorage, writable: true });

// Provide a fake process.env.EXPO_PUBLIC_API_URL
process.env.EXPO_PUBLIC_API_URL = "https://routeflowapi-production-d504.up.railway.app";

// ── Auth key constants (must match lib/auth-keys.ts) ─────────────────────────
const OP_ACCESS_KEY    = "rf:op:accessToken";
const DRIVER_ACCESS_KEY = "rf:driver:accessToken";
const BUYER_ACCESS_KEY  = "rf:buyer:accessToken";
const LEGACY_BUYER_KEY  = "buyerAccessToken";

// ── Fake JWT (non-expiring for tests, role injected as readable payload) ──────
function fakeJwt(role: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({
    sub: "user-123",
    username: "testuser",
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  return `${header}.${payload}.fakesig`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Clear local storage
  for (const k of Object.keys(localStorageStore)) delete localStorageStore[k];
  mockAuthStore.user = null;
  mockBuyerStore.buyer = null;
});

describe("useSocket — operator", () => {
  it("calls io() with the token from rf:op:accessToken", async () => {
    const token = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = token;
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };

    // Dynamic import after mocks are in place
    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    // io() is async — allow microtasks to flush
    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledWith(
      expect.stringContaining("routeflowapi-production-d504.up.railway.app"),
      expect.objectContaining({ auth: { token } }),
    );
  });

  it("does NOT call io() when no user is present", async () => {
    mockAuthStore.user = null;
    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();
  });

  it("does NOT call io() if the token is missing from storage", async () => {
    // token NOT placed in storage
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };
    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();
  });
});

describe("useSocket — driver", () => {
  it("calls io() with the token from rf:driver:accessToken", async () => {
    const token = fakeJwt("DRIVER");
    localStorageStore[DRIVER_ACCESS_KEY] = token;
    mockAuthStore.user = { role: "DRIVER", id: "driver-456" };

    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ auth: { token } }),
    );
  });

  it("does NOT fall back to the operator key when role is DRIVER", async () => {
    const opToken = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = opToken;
    // Only driver key is empty — the hook should fail to find a token
    mockAuthStore.user = { role: "DRIVER", id: "driver-456" };

    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();
  });
});

describe("useBuyerSocket — RF-002 / NEW-m2-1 key fix", () => {
  it("calls io() with the token from rf:buyer:accessToken (namespaced key)", async () => {
    const token = fakeJwt("BUYER");
    localStorageStore[BUYER_ACCESS_KEY] = token;
    mockBuyerStore.buyer = { id: "buyer-789" };

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");
    useBuyerSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ auth: { token } }),
    );
  });

  it("does NOT call io() when token is only in the legacy 'buyerAccessToken' key", async () => {
    // Regression: before RF-002 fix, the hook read "buyerAccessToken" — after
    // the fix it must read "rf:buyer:accessToken". A token in the legacy slot
    // should NOT cause a connection (the migration moves it; if it's still
    // there it means migration hasn't run, so we should not connect with a
    // potentially stale token from an unrelated session).
    const token = fakeJwt("BUYER");
    localStorageStore[LEGACY_BUYER_KEY] = token;   // legacy key only
    mockBuyerStore.buyer = { id: "buyer-789" };

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");
    useBuyerSocket();

    await Promise.resolve();
    await Promise.resolve();

    // Must NOT have connected — the namespaced key is absent
    expect(mockIo).not.toHaveBeenCalled();
  });

  it("does NOT call io() when no buyer is present", async () => {
    localStorageStore[BUYER_ACCESS_KEY] = fakeJwt("BUYER");
    mockBuyerStore.buyer = null;

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");
    useBuyerSocket();

    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();
  });
});
