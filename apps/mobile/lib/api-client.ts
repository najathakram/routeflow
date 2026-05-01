import axios, { type InternalAxiosRequestConfig } from "axios";
import { Platform } from "react-native";
import { useOfflineQueue } from "../store/offlineQueue";
import { OP_KEYS, DRIVER_KEYS } from "./auth-keys";

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
 * Return whichever namespaced access token is present (op slot first, then driver).
 * NEW-m2-1 / RF-077: tokens are keyed by role to prevent cross-role overwrite.
 */
async function getActiveAccessToken(): Promise<string | null> {
  const op = await storageGet(OP_KEYS.accessToken);
  if (op) return op;
  return storageGet(DRIVER_KEYS.accessToken);
}

async function getActiveRefreshToken(): Promise<{ token: string; isDriver: boolean } | null> {
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
      useOfflineQueue.getState().enqueue({
        endpoint: original?.url ?? "",
        method: (original?.method ?? "POST").toUpperCase() as "POST" | "PATCH" | "PUT" | "DELETE",
        body,
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
      // Navigation is handled by the auth store watching user state
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
