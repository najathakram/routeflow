/**
 * RF-002 Socket wiring smoke tests
 *
 * Verifies that:
 * 1. useSocket reads the operator token from the role-namespaced key (rf:op:accessToken)
 * 2. useSocket reads the driver token from the role-namespaced key (rf:driver:accessToken)
 * 3. useBuyerSocket reads the buyer token from the role-namespaced key (rf:buyer:accessToken)
 *    (not the legacy "buyerAccessToken" key that was migrated away in NEW-m2-1/RF-077)
 * 4. socket.io io() is called with the token and the correct API URL
 * 5. Hook skips connect when window/localStorage are absent (SSR guard)
 * 6. Hook re-runs and connects when user transitions from null → set
 * 7. Transport order is ["polling", "websocket"] — polling first so Railway
 *    proxy handshake always succeeds before the WS upgrade attempt
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock socket.io-client before any import that uses it
const mockSocketOn = jest.fn();
const mockSocketDisconnect = jest.fn();
const mockIo = jest.fn(() => ({
  on: mockSocketOn,
  disconnect: mockSocketDisconnect,
  id: "test-socket-id",
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

// Fake localStorage for the web path.
// We wrap the value in an object so SSR tests can swap .getItem out.
const localStorageStore: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, val: string) => { localStorageStore[key] = val; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
};

// Initial property definition (configurable so SSR tests can override)
Object.defineProperty(global, "localStorage", {
  value: mockLocalStorage,
  writable: true,
  configurable: true,
});

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
  // Clear local storage values (but keep the mock object itself)
  for (const k of Object.keys(localStorageStore)) delete localStorageStore[k];
  mockAuthStore.user = null;
  mockBuyerStore.buyer = null;
  // Restore localStorage mock to default (in case a test swapped getItem)
  mockLocalStorage.getItem = (key: string) => localStorageStore[key] ?? null;
  // Restore global.localStorage reference and simulate browser environment.
  // The SSR guard checks globalThis.window and globalThis.localStorage;
  // setting them here ensures non-SSR tests see a "browser-like" globalThis.
  (global as Record<string, unknown>).localStorage = mockLocalStorage;
  (global as Record<string, unknown>).window = global; // truthy — simulates browser
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

  it("uses polling-first transport order for Railway proxy compatibility", async () => {
    const token = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = token;
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };

    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        transports: ["polling", "websocket"],
      }),
    );
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

describe("useSocket — SSR guard", () => {
  it("does NOT call io() when window is undefined (SSR/pre-render context)", async () => {
    const token = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = token;
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };

    // Simulate SSR: temporarily hide window
    const savedWindow = (global as Record<string, unknown>).window;
    (global as Record<string, unknown>).window = undefined;

    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).not.toHaveBeenCalled();

    // Restore
    (global as Record<string, unknown>).window = savedWindow;
  });

  it("does NOT call io() when localStorage is undefined (SSR/pre-render context)", async () => {
    const token = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = token;
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };

    // Simulate SSR: temporarily hide localStorage
    (global as Record<string, unknown>).localStorage = undefined;

    const { useSocket } = await import("../hooks/useSocket");
    useSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).not.toHaveBeenCalled();

    // Restore
    (global as Record<string, unknown>).localStorage = mockLocalStorage;
  });

  it("does NOT throw when localStorage is undefined (no unhandled error)", async () => {
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };
    (global as Record<string, unknown>).localStorage = undefined;

    const { useSocket } = await import("../hooks/useSocket");
    // Should not throw
    expect(() => useSocket()).not.toThrow();

    await Promise.resolve();
    // Restore
    (global as Record<string, unknown>).localStorage = mockLocalStorage;
  });
});

describe("useSocket — user hydration (null → set)", () => {
  it("connects when the effect re-runs after user transitions from null to set", async () => {
    // Simulates the real sequence: hook mounts with user=null (auth loading),
    // then user becomes set (initialize() resolves).
    // With useEffect mocked to run immediately, we call the hook twice —
    // once with null user (should not connect) and once with user set.
    const token = fakeJwt("OPERATOR");
    localStorageStore[OP_ACCESS_KEY] = token;

    const { useSocket } = await import("../hooks/useSocket");

    // Phase 1: user is null → no connect
    mockAuthStore.user = null;
    useSocket();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();

    // Phase 2: user is set → effect re-fires → should connect
    mockAuthStore.user = { role: "OPERATOR", id: "user-123" };
    useSocket();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ auth: { token } }),
    );
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

  it("uses polling-first transport order for Railway proxy compatibility", async () => {
    const token = fakeJwt("BUYER");
    localStorageStore[BUYER_ACCESS_KEY] = token;
    mockBuyerStore.buyer = { id: "buyer-789" };

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");
    useBuyerSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        transports: ["polling", "websocket"],
      }),
    );
  });

  it("does NOT call io() in SSR context (no window)", async () => {
    const token = fakeJwt("BUYER");
    localStorageStore[BUYER_ACCESS_KEY] = token;
    mockBuyerStore.buyer = { id: "buyer-789" };

    const savedWindow = (global as Record<string, unknown>).window;
    (global as Record<string, unknown>).window = undefined;

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");
    useBuyerSocket();

    await Promise.resolve();
    await Promise.resolve();

    expect(mockIo).not.toHaveBeenCalled();

    (global as Record<string, unknown>).window = savedWindow;
  });

  it("connects when buyer transitions from null to set", async () => {
    const token = fakeJwt("BUYER");
    localStorageStore[BUYER_ACCESS_KEY] = token;

    const { useBuyerSocket } = await import("../hooks/useBuyerSocket");

    // Phase 1: buyer is null
    mockBuyerStore.buyer = null;
    useBuyerSocket();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).not.toHaveBeenCalled();

    // Phase 2: buyer is set
    mockBuyerStore.buyer = { id: "buyer-789" };
    useBuyerSocket();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockIo).toHaveBeenCalledTimes(1);
    expect(mockIo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ auth: { token } }),
    );
  });
});
