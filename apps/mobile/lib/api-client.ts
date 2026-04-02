import axios from "axios";
import { Platform } from "react-native";

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

// ─── Request interceptor: attach access token ────────────────────────────────

apiClient.interceptors.request.use(async (config) => {
  const token = await storageGet("accessToken");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─── Response interceptor: refresh on 401 ────────────────────────────────────

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

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as typeof error.config & {
      _retry?: boolean;
    };

    if (error.response?.status !== 401 || original._retry) {
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
      const refreshToken = await storageGet("refreshToken");
      if (!refreshToken) throw new Error("No refresh token");

      const { data } = await axios.post(`${BASE_URL}/api/v1/auth/refresh`, {
        refreshToken,
      });
      await storageSet("accessToken", data.accessToken);
      await storageSet("refreshToken", data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return apiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await storageDel("accessToken");
      await storageDel("refreshToken");
      // Navigation is handled by the auth store watching user state
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
