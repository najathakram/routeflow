/**
 * T3 (bug-test-plan.md) — REG-B136: durable POD + settlement, no duplicate
 * re-attach.
 *
 * Design of record: cause-ruling.md §3 D3. `store/podStore.ts` and
 * `store/runSettlementStore.ts` used to be plain in-memory `create(...)`
 * stores — a kill mid-route lost every captured photo/signature/cash tally.
 * The fix persists both through the shared `userScopedStorage`
 * (lib/user-scoped-storage.ts) under a key scoped to the signed-in USER —
 * deliberately no tenant segment, because the tenant slug is populated
 * asynchronously long after the stores are created, so the store would
 * rehydrate from a key it never wrote to. Hydration is therefore explicit:
 * both stores set `skipHydration: true` and `lib/auth-store.ts` calls
 * `rehydrateUserScopedStores()` once the user is known. On relaunch the stop
 * screen reconciles local artifacts against what the server already holds
 * before re-attaching — `pendingPodArtifacts` +
 * `artifactIdsFromPodPhotoUrls` (lib/pod-reconcile.ts) are that
 * reconciliation.
 *
 * A/B are source-text pins on the two stores' persist config (comment-
 * stripped so a mention in prose can't satisfy either check) — mobile Jest
 * has no AsyncStorage harness for a real zustand-persist hydration cycle.
 * The load-bearing behaviour is pinned for real by D (the storage key
 * function) and E (the explicit rehydration call sites), so renaming the
 * storage identifier or dropping either mechanism turns this file red.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { podPhotoArtifactId } from "../lib/pod-artifacts";
import {
  pendingPodArtifacts,
  artifactIdsFromPodPhotoUrls,
  type PendingArtifactCandidate,
} from "../lib/pod-reconcile";
import { userScopedStorageKey } from "../lib/user-scoped-storage";
import { getStoredUser, type AuthUser } from "../lib/auth";

// `lib/user-scoped-storage` pulls in AsyncStorage at module scope and resolves
// the effective key from the signed-in user — both are stubbed so the REAL key
// function runs in the plain node environment (ts-jest hoists these factories
// above the imports).
jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

jest.mock("../lib/auth", () => ({
  getStoredUser: jest.fn(),
}));

const mockGetStoredUser = getStoredUser as jest.MockedFunction<typeof getStoredUser>;

/** A stored staff user; only `id` matters to the storage key. */
const storedUser = (id: string): AuthUser => ({
  id,
  username: id,
  role: "DRIVER",
  status: "ACTIVE",
  forcePasswordChange: false,
  isAdmin: false,
  canActAsDriver: true,
});

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

describe("REG-B136-A: podStore persists under a user-scoped key", () => {
  const src = stripComments(readFileSync(join(__dirname, "..", "store", "podStore.ts"), "utf8"));

  it("wires zustand's persist middleware — TODAY: create<PodState>((set) => …) with no persist at all", () => {
    expect(src).toMatch(/from\s+["']zustand\/middleware["']/);
    expect(src).toMatch(/persist\s*\(/);
  });

  it("persists through the shared user-scoped storage and skips import-time hydration", () => {
    // Gate on the persist call being there at all, so this fails on "no
    // persist config" rather than silently applying the oracle to an empty
    // string when the isolation regex misses.
    const persistMatch = src.match(/persist\s*\(([\s\S]*)$/);
    expect(persistMatch).not.toBeNull();
    const persistBlock = persistMatch ? persistMatch[1] : "";
    expect(persistBlock).toMatch(/createJSONStorage\(\s*\(\)\s*=>\s*userScopedStorage\s*\)/);
    expect(persistBlock).toMatch(/skipHydration\s*:\s*true/);
  });
});

describe("REG-B136-B: runSettlementStore persists likewise", () => {
  const src = stripComments(
    readFileSync(join(__dirname, "..", "store", "runSettlementStore.ts"), "utf8"),
  );

  it("wires zustand's persist middleware — TODAY: plain in-memory create(), comment says so explicitly", () => {
    expect(src).toMatch(/from\s+["']zustand\/middleware["']/);
    expect(src).toMatch(/persist\s*\(/);
  });

  it("persists through the shared user-scoped storage and skips import-time hydration", () => {
    const persistMatch = src.match(/persist\s*\(([\s\S]*)$/);
    expect(persistMatch).not.toBeNull();
    const persistBlock = persistMatch ? persistMatch[1] : "";
    expect(persistBlock).toMatch(/createJSONStorage\(\s*\(\)\s*=>\s*userScopedStorage\s*\)/);
    expect(persistBlock).toMatch(/skipHydration\s*:\s*true/);
  });
});

describe("REG-B136-C: pendingPodArtifacts skips artifacts the server already holds", () => {
  const dataUrlA = "data:image/jpeg;base64,AAAA";
  const dataUrlB = "data:image/jpeg;base64,BBBB";
  const idA = podPhotoArtifactId(dataUrlA);
  const idB = podPhotoArtifactId(dataUrlB);

  it("excludes a local artifact whose id/hash the server stop already has — TODAY: helper is an unfilled stub", () => {
    const local: PendingArtifactCandidate[] = [
      { artifactId: idA, dataUrl: dataUrlA },
      { artifactId: idB, dataUrl: dataUrlB },
    ];

    const result = pendingPodArtifacts(local, { podArtifactIds: [idA] });

    expect(result).toBeTruthy();
    expect(result!.map((a) => a.artifactId)).toEqual([idB]);
  });

  it("returns every local artifact when the server holds none of them yet — TODAY: unfilled stub", () => {
    const local: PendingArtifactCandidate[] = [{ artifactId: idA, dataUrl: dataUrlA }];

    const result = pendingPodArtifacts(local, { podArtifactIds: [] });

    expect(result).toBeTruthy();
    expect(result!.map((a) => a.artifactId)).toEqual([idA]);
  });
});

describe("REG-B136-D: userScopedStorageKey namespaces the blob by the signed-in user", () => {
  afterEach(() => {
    mockGetStoredUser.mockReset();
  });

  it("keys the POD blob by the signed-in user's id", async () => {
    mockGetStoredUser.mockResolvedValue(storedUser("u-1"));

    await expect(userScopedStorageKey("routeflow-pod-store")).resolves.toBe(
      "routeflow-pod-store:u-1",
    );
  });

  it("falls back to the anon bucket when no user is stored", async () => {
    mockGetStoredUser.mockResolvedValue(null);

    await expect(userScopedStorageKey("routeflow-pod-store")).resolves.toBe(
      "routeflow-pod-store:anon",
    );
  });

  it("keeps two drivers on the same device in separate buckets", async () => {
    mockGetStoredUser.mockResolvedValue(storedUser("u-1"));
    const first = await userScopedStorageKey("routeflow-run-settlement");
    mockGetStoredUser.mockResolvedValue(storedUser("u-2"));
    const second = await userScopedStorageKey("routeflow-run-settlement");

    expect(first).toBe("routeflow-run-settlement:u-1");
    expect(second).toBe("routeflow-run-settlement:u-2");
    expect(first).not.toBe(second);
  });
});

describe("REG-B136-D2: artifactIdsFromPodPhotoUrls reads back what the server already holds", () => {
  const dataUrlA = "data:image/jpeg;base64,AAAA";
  const dataUrlB = "data:image/jpeg;base64,BBBB";
  const idA = podPhotoArtifactId(dataUrlA);
  const idB = podPhotoArtifactId(dataUrlB);
  const serverUrl = (id: string) => `tenants/acme/pod/stop-1/photo-${id}.jpg`;

  it("returns exactly the artifact ids carried by the stop's stored POD keys, in order", () => {
    expect(artifactIdsFromPodPhotoUrls([serverUrl(idA), serverUrl(idB)])).toEqual([idA, idB]);
  });

  it("returns [] for an absent or empty podPhotoUrls", () => {
    expect(artifactIdsFromPodPhotoUrls(undefined)).toEqual([]);
    expect(artifactIdsFromPodPhotoUrls([])).toEqual([]);
  });

  it("yields no id for a url that is not a stored POD key, so a real capture is never masked", () => {
    expect(artifactIdsFromPodPhotoUrls([dataUrlA, "https://cdn.example/legacy.jpg"])).toEqual([]);
  });

  it("composed with pendingPodArtifacts, drops only the artifact the server already holds", () => {
    const local: PendingArtifactCandidate[] = [
      { artifactId: idA, dataUrl: dataUrlA },
      { artifactId: idB, dataUrl: dataUrlB },
    ];

    const pending = pendingPodArtifacts(local, {
      podArtifactIds: artifactIdsFromPodPhotoUrls([serverUrl(idA)]),
    });

    expect(pending.map((a) => a.artifactId)).toEqual([idB]);
  });
});

describe("REG-B136-E: every sign-in path explicitly rehydrates the user-scoped stores", () => {
  const src = stripComments(readFileSync(join(__dirname, "..", "lib", "auth-store.ts"), "utf8"));

  // Skip the AuthState interface — its members carry the same 2-space labels
  // as the store's methods, and a type declaration proves nothing.
  const storeStart = src.search(/useAuthStore\s*=\s*create</);
  const storeSrc = storeStart < 0 ? "" : src.slice(storeStart);

  /** Slice one store method's body: its label to the next top-level label. */
  function methodBody(name: string): string | null {
    const label = new RegExp(`^ {2}${name}:`, "m");
    const start = storeSrc.search(label);
    if (start < 0) return null;
    const rest = storeSrc.slice(start + `  ${name}:`.length);
    const end = rest.search(/^ {2}[A-Za-z_$][\w$]*:|^\}\)\);/m);
    return end < 0 ? rest : rest.slice(0, end);
  }

  it.each(["login", "loginWithGoogle", "initialize"])(
    "%s() awaits rehydrateUserScopedStores() — the stores skipHydration, so this is the only hydration point",
    (method) => {
      const body = methodBody(method);
      expect(body).not.toBeNull();
      expect(body!).toMatch(/await\s+rehydrateUserScopedStores\(\)/);
    },
  );
});

/**
 * REG-B136-G — behavioral counterpart to REG-B136-E above: `login()` /
 * `loginWithGoogle()` / `initialize()` calling `rehydrateUserScopedStores()`
 * only proves the ONE call site exists, not that it actually reaches BOTH
 * skipHydration stores. `lib/session-hydrate.ts` is the sole hydration point
 * (both stores set `skipHydration: true`, see REG-B136-A/B above) — an
 * emptied body here turns this file red without touching auth-store.ts at
 * all, which is exactly the gap REG-B136-E's source-text pin cannot see.
 */
describe("REG-B136-G: rehydrateUserScopedStores hydrates both skipHydration stores", () => {
  const podRehydrate = jest.fn();
  const runSettlementRehydrate = jest.fn();

  jest.mock("../store/podStore", () => ({
    usePodStore: { persist: { rehydrate: (...args: unknown[]) => podRehydrate(...args) } },
  }));
  jest.mock("../store/runSettlementStore", () => ({
    useRunSettlementStore: {
      persist: { rehydrate: (...args: unknown[]) => runSettlementRehydrate(...args) },
    },
  }));

  beforeEach(() => {
    jest.resetModules();
    podRehydrate.mockReset();
    runSettlementRehydrate.mockReset();
  });

  it("calls persist.rehydrate() on BOTH stores — TODAY (emptied body): 0 calls on either", async () => {
    const { rehydrateUserScopedStores } = await import("../lib/session-hydrate");

    await rehydrateUserScopedStores();

    expect(podRehydrate).toHaveBeenCalledTimes(1);
    expect(runSettlementRehydrate).toHaveBeenCalledTimes(1);
  });

  it("a rejecting rehydrate on one store never blocks the other, or the caller — best-effort per store", async () => {
    podRehydrate.mockImplementation(() => Promise.reject(new Error("hydrate blew up")));
    const { rehydrateUserScopedStores } = await import("../lib/session-hydrate");

    await expect(rehydrateUserScopedStores()).resolves.toBeUndefined();

    expect(runSettlementRehydrate).toHaveBeenCalledTimes(1);
  });
});
