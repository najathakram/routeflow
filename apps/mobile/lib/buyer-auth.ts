import axios from "axios";
import { Platform } from "react-native";

// ─── Web-safe storage ─────────────────────────────────────────────────────────

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return localStorage.getItem(key);
    const { getItemAsync } = await import("expo-secure-store");
    return getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") { localStorage.setItem(key, value); return; }
    const { setItemAsync } = await import("expo-secure-store");
    await setItemAsync(key, value);
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === "web") { localStorage.removeItem(key); return; }
    const { deleteItemAsync } = await import("expo-secure-store");
    await deleteItemAsync(key);
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuyerUser {
  id: string;
  email: string;
  name: string;
}

export interface BuyerSeller {
  linkId: string;
  linkStatus: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    logoKey: string | null;
    primaryColor: string | null;
  };
  customer: {
    id: string;
    businessName: string;
    email: string | null;
  };
}

interface BuyerAuthResponse {
  accessToken: string;
  refreshToken: string;
  buyer: BuyerUser;
}

// ─── Buyer API client (separate from staff apiClient) ─────────────────────────

const BASE_URL =
  (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const buyerApiClient = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  timeout: 15000,
});

// ─── Request interceptor: attach buyer token + active tenant slug ─────────────

buyerApiClient.interceptors.request.use(async (config) => {
  const [token, activeSellerRaw] = await Promise.all([
    storage.get("buyerAccessToken"),
    storage.get("buyerActiveSeller"),
  ]);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (activeSellerRaw) {
    try {
      const seller: BuyerSeller = JSON.parse(activeSellerRaw);
      if (seller?.tenant?.slug) {
        config.headers["X-Tenant-Slug"] = seller.tenant.slug;
      }
    } catch {
      // Malformed storage — ignore
    }
  }
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

buyerApiClient.interceptors.response.use(
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
            resolve(buyerApiClient(original));
          },
          reject,
        });
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      const refreshToken = await storage.get("buyerRefreshToken");
      if (!refreshToken) throw new Error("No buyer refresh token");

      const { data } = await axios.post<BuyerAuthResponse>(
        `${BASE_URL}/api/v1/buyer/auth/refresh`,
        { refreshToken },
      );
      await storage.set("buyerAccessToken", data.accessToken);
      await storage.set("buyerRefreshToken", data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return buyerApiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await storage.del("buyerAccessToken");
      await storage.del("buyerRefreshToken");
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

// ─── JWT parsing ──────────────────────────────────────────────────────────────

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

// ─── Auth functions ───────────────────────────────────────────────────────────

export async function buyerLogin(
  email: string,
  password: string,
): Promise<BuyerAuthResponse> {
  const { data } = await buyerApiClient.post<BuyerAuthResponse>(
    "/buyer/auth/login",
    { email, password },
  );
  await storage.set("buyerAccessToken", data.accessToken);
  await storage.set("buyerRefreshToken", data.refreshToken);
  return data;
}

export async function buyerRegister(
  email: string,
  password: string,
  name: string,
): Promise<BuyerAuthResponse> {
  const { data } = await buyerApiClient.post<BuyerAuthResponse>(
    "/buyer/auth/register",
    { email, password, name },
  );
  await storage.set("buyerAccessToken", data.accessToken);
  await storage.set("buyerRefreshToken", data.refreshToken);
  return data;
}

export async function buyerLogout(): Promise<void> {
  try {
    await buyerApiClient.post("/buyer/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless
  }
  await storage.del("buyerAccessToken");
  await storage.del("buyerRefreshToken");
  await storage.del("buyerActiveSeller");
}

export async function buyerRefreshTokens(): Promise<BuyerAuthResponse | null> {
  const refreshToken = await storage.get("buyerRefreshToken");
  if (!refreshToken) return null;
  try {
    const { data } = await buyerApiClient.post<BuyerAuthResponse>(
      "/buyer/auth/refresh",
      { refreshToken },
    );
    await storage.set("buyerAccessToken", data.accessToken);
    await storage.set("buyerRefreshToken", data.refreshToken);
    return data;
  } catch {
    return null;
  }
}

export async function getStoredBuyer(): Promise<BuyerUser | null> {
  const token = await storage.get("buyerAccessToken");
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return null;
  }
  // Buyer JWTs have type: 'BUYER'
  if ((payload.type as string) !== "BUYER") return null;
  return {
    id: payload.sub as string,
    email: payload.email as string,
    name: payload.name as string,
  };
}

export async function getBuyerSellers(): Promise<BuyerSeller[]> {
  const { data } = await buyerApiClient.get<BuyerSeller[]>("/buyer/sellers");
  return data;
}

export async function getActiveSeller(): Promise<BuyerSeller | null> {
  const raw = await storage.get("buyerActiveSeller");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuyerSeller;
  } catch {
    return null;
  }
}

export async function setActiveSeller(seller: BuyerSeller): Promise<void> {
  await storage.set("buyerActiveSeller", JSON.stringify(seller));
}
