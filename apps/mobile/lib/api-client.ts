import axios, { type InternalAxiosRequestConfig } from "axios";
import { Platform } from "react-native";
import { useOfflineQueue } from "../store/offlineQueue";
import { OP_KEYS, DRIVER_KEYS, CURRENT_ROLE_KEY, type CurrentRole } from "./auth-keys";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export const apiClient = axios.create({ baseURL: `${BASE_URL}/api/v1`, timeout: 15000 });

// ─── Web-safe storage (mirrors auth.ts storage wrapper) ──────────────────────

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(key);
  const { getItemAsync } = await import("expo-secure-store");
  return getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(key, value);
    return;
  }
  const { setItemAsync } = await import("expo-secure-store");
  await setItemAsync(key, value);
}

async function storageDel(key: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.removeItem(key);
    return;
  }
  const { deleteItemAsync } = await import("expo-secure-store");
  await deleteItemAsync(key);
}

/**
 * Return whichever namespaced access token is present, preferring the bucket
 * matching the rf:currentRole marker (BUG-XR1-4). Without this, an expired
 * operator token from a prior session would let a stale driver token answer
 * for an operator request, hijacking the role context.
 */
async function getActiveAccessToken(): Promise<string | null> {
  const marker = (await storageGet(CURRENT_ROLE_KEY)) as CurrentRole | null;
  if (marker === "driver") {
    const driver = await storageGet(DRIVER_KEYS.accessToken);
    if (driver) return driver;
  } else if (marker === "operator") {
    const op = await storageGet(OP_KEYS.accessToken);
    if (op) return op;
  }
  // Marker missing or its bucket empty — fall back to op-then-driver order
  // so legacy sessions seeded before the marker still work.
  const op = await storageGet(OP_KEYS.accessToken);
  if (op) return op;
  return storageGet(DRIVER_KEYS.accessToken);
}

async function getActiveRefreshToken(): Promise<{ token: string; isDriver: boolean } | null> {
  const marker = (await storageGet(CURRENT_ROLE_KEY)) as CurrentRole | null;
  if (marker === "driver") {
    const driver = await storageGet(DRIVER_KEYS.refreshToken);
    if (driver) return { token: driver, isDriver: true };
  } else if (marker === "operator") {
    const op = await storageGet(OP_KEYS.refreshToken);
    if (op) return { token: op, isDriver: false };
  }
  const op = await storageGet(OP_KEYS.refreshToken);
  if (op) return { token: op, isDriver: false };
  const driver = await storageGet(DRIVER_KEYS.refreshToken);
  if (driver) return { token: driver, isDriver: true };
  return null;
}

// ─── Request interceptor: attach access token + tenant slug ──────────────────

apiClient.interceptors.request.use(async (config) => {
  const [token, tenantSlug] = await Promise.all([getActiveAccessToken(), storageGet("tenantSlug")]);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (tenantSlug) config.headers["X-Tenant-Slug"] = tenantSlug;
  return config;
});

// ─── Staff session-expired callback (set by auth-store on init) ───────────────
//
// Mirrors buyer-auth.ts registerBuyerSessionExpiredHandler: when a staff 401
// refresh fails, clearing the storage tokens is not enough — useAuthStore still
// holds {user, activeRole} in memory, so the root layout's redirect-to-login
// never fires and the user is stranded on a screen whose every API call 401s.
// The auth store registers a handler at boot; we invoke it on refresh failure
// to clear in-memory state and let the layout redirect. The persisted tenant
// slug survives the wipe, so the login screen renders with Google available.

let staffSessionExpiredHandler: (() => void) | null = null;
export function registerStaffSessionExpiredHandler(fn: () => void): void {
  staffSessionExpiredHandler = fn;
}

// ─── Response interceptor: offline queue + 401 refresh ───────────────────────

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach((p) => {
    if (error) p.reject(error);
    else p.resolve(token!);
  });
  failedQueue = [];
}

type ExtendedConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
  _offlineQueued?: boolean;
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as ExtendedConfig;

    // ── Offline: network error (no response) on a mutating request ──────────
    const isNetworkError = !error.response && !!error.request;
    const isMutation = ["POST", "PATCH", "PUT", "DELETE"].includes(
      (original?.method ?? "").toUpperCase(),
    );
    const isFormData = original?.data instanceof FormData;
    // REG-B196 (T-B196a): a no-response error used to be classified as
    // "offline" unconditionally. That is wrong for a TIMEOUT — the request
    // reached the network and may well have committed server-side, so
    // queueing it risks a duplicate write while the operator still has the
    // full cart open. A timeout is therefore only treated as offline when the
    // app affirmatively KNOWS it is offline.
    //
    // A hard transport failure (ERR_NETWORK / no code — DNS or route failure,
    // raised immediately instead of after the 15s timeout) is the shape a
    // genuinely offline device produces, and it never reached a server. Those
    // stay queued unconditionally, because `isOnline` is a positive signal
    // only useNetworkSync's NetInfo listener ever writes: it defaults to true,
    // is deliberately not persisted, and nothing outside the (driver)/
    // (operator) layouts mounts that listener. Gating the whole queue on it
    // would silently drop offline mutations on every cold start and inside
    // NetInfo's reachability-probe window (isInternetReachable === null).
    const isTimeout = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
    const queueAsOffline = !isTimeout || useOfflineQueue.getState().isOnline === false;

    if (
      isNetworkError &&
      isMutation &&
      !isFormData &&
      !original?._offlineQueued &&
      queueAsOffline
    ) {
      if (original) original._offlineQueued = true;
      let body: unknown;
      try {
        body = typeof original?.data === "string" ? JSON.parse(original.data) : original?.data;
      } catch {
        body = undefined;
      }
      // Preserve idempotency-key (and any other replay-safe headers) so a
      // queued mutation that succeeds server-side but loses the response is
      // rejected as a duplicate on retry instead of being applied twice.
      const replayHeaders: Record<string, string> = {};
      const rawHeaders = original?.headers as Record<string, unknown> | undefined;
      if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof v !== "string") continue;
          const lk = k.toLowerCase();
          if (lk === "idempotency-key") replayHeaders[k] = v;
        }
      }
      useOfflineQueue.getState().enqueue({
        endpoint: original?.url ?? "",
        method: (original?.method ?? "POST").toUpperCase() as "POST" | "PATCH" | "PUT" | "DELETE",
        body,
        ...(Object.keys(replayHeaders).length > 0 ? { headers: replayHeaders } : {}),
      });
      return Promise.reject(
        Object.assign(new Error("You are offline. Action queued."), { isOfflineQueued: true }),
      );
    }

    // ── 401 token refresh ───────────────────────────────────────────────────
    // Never auto-refresh on the auth endpoints themselves — a 401 from
    // /auth/login or /auth/refresh is the caller's signal to surface the
    // error, not to recurse and wipe tokens.
    const url = original?.url ?? "";
    const isAuthEndpoint =
      url.includes("/auth/login") || url.includes("/auth/refresh") || url.includes("/auth/logout");
    if (error.response?.status !== 401 || original?._retry || isAuthEndpoint) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        failedQueue.push({
          resolve: (token) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(apiClient(original));
          },
          reject,
        });
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      const refreshEntry = await getActiveRefreshToken();
      if (!refreshEntry) throw new Error("No refresh token");

      const { data } = await axios.post(`${BASE_URL}/api/v1/auth/refresh`, {
        refreshToken: refreshEntry.token,
      });

      const keys = refreshEntry.isDriver ? DRIVER_KEYS : OP_KEYS;
      await storageSet(keys.accessToken, data.accessToken);
      await storageSet(keys.refreshToken, data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return apiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await storageDel(OP_KEYS.accessToken);
      await storageDel(OP_KEYS.refreshToken);
      await storageDel(DRIVER_KEYS.accessToken);
      await storageDel(DRIVER_KEYS.refreshToken);
      await storageDel(CURRENT_ROLE_KEY);
      try {
        staffSessionExpiredHandler?.();
      } catch {
        // A handler error must never mask the original 401.
      }
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
