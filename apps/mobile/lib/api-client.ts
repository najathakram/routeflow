import axios, { type InternalAxiosRequestConfig } from "axios";
import { Platform } from "react-native";
import { useOfflineQueue } from "../store/offlineQueue";
import { OP_KEYS, DRIVER_KEYS, CURRENT_ROLE_KEY, type CurrentRole } from "./auth-keys";

const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export const apiClient = axios.create({ baseURL: `${BASE_URL}/api/v1`, timeout: 15000 });

// ─── Web-safe storage (mirrors auth.ts storage wrapper) ──────────────────────

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(key);
  const { getItemAsync } = await import("expo-secure-store");
  return getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") { localStorage.setItem(key, value); return; }
  const { setItemAsync } = await import("expo-secure-store");
  await setItemAsync(key, value);
}

async function storageDel(key: string): Promise<void> {
  if (Platform.OS === "web") { localStorage.removeItem(key); return; }
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
  const [token, tenantSlug] = await Promise.all([
    getActiveAccessToken(),
    storageGet("tenantSlug"),
  ]);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (tenantSlug) config.headers["X-Tenant-Slug"] = tenantSlug;
  return config;
});

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

    if (isNetworkError && isMutation && !isFormData && !original?._offlineQueued) {
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
      url.includes("/auth/login") ||
      url.includes("/auth/refresh") ||
      url.includes("/auth/logout");
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
      // Navigation is handled by the auth store watching user state
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
