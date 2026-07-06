import axios from "axios";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { BUYER_KEYS } from "./auth-keys";

// ─── Web-safe storage ─────────────────────────────────────────────────────────

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return localStorage.getItem(key);
    const { getItemAsync } = await import("expo-secure-store");
    return getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      localStorage.setItem(key, value);
      return;
    }
    const { setItemAsync } = await import("expo-secure-store");
    await setItemAsync(key, value);
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === "web") {
      localStorage.removeItem(key);
      return;
    }
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

// ─── Legacy key migration (NEW-m2-1 / RF-077) ────────────────────────────────

const LEGACY_ACCESS = "buyerAccessToken";
const LEGACY_REFRESH = "buyerRefreshToken";
const LEGACY_SELLER = "buyerActiveSeller";

/**
 * One-time migration: copy legacy buyerAccessToken → rf:buyer:accessToken then
 * delete the legacy keys. Idempotent — safe to call on every app start.
 */
export async function migrateLegacyBuyerToken(): Promise<void> {
  const legacy = await storage.get(LEGACY_ACCESS);
  if (!legacy) return;
  const existing = await storage.get(BUYER_KEYS.accessToken);
  if (!existing) {
    await storage.set(BUYER_KEYS.accessToken, legacy);
    const legacyRefresh = await storage.get(LEGACY_REFRESH);
    if (legacyRefresh) await storage.set(BUYER_KEYS.refreshToken, legacyRefresh);
    const legacySeller = await storage.get(LEGACY_SELLER);
    if (legacySeller) await storage.set(BUYER_KEYS.activeSeller, legacySeller);
  }
  await storage.del(LEGACY_ACCESS);
  await storage.del(LEGACY_REFRESH);
  await storage.del(LEGACY_SELLER);
}

// ─── Session-expired callback (set by buyer-session-store on init) ───────────
//
// BUG-B1-1: when a buyer 401 refresh fails, simply clearing the storage tokens
// is not enough — the zustand session store still has {buyer, activeSeller}
// set, so the root layout's redirect-to-login does not fire and the UI stays
// stuck on a screen that calls APIs which all 401. The store registers an
// onSessionExpired handler at boot; we invoke it here to clear in-memory
// state and let the layout redirect.

let buyerSessionExpiredHandler: (() => void) | null = null;
export function registerBuyerSessionExpiredHandler(fn: () => void): void {
  buyerSessionExpiredHandler = fn;
}

// ─── Buyer API client (separate from staff apiClient) ─────────────────────────

const BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const buyerApiClient = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  timeout: 15000,
  // Serialize array params as repeated keys (?statuses=A&statuses=B) instead of
  // axios's default bracket notation (?statuses[]=A&statuses[]=B). The API's
  // ValidationPipe runs forbidNonWhitelisted=true and rejects the literal key
  // "statuses[]" because the server-side query parser doesn't unwrap brackets.
  paramsSerializer: { indexes: null },
});

// ─── Request interceptor: attach buyer token + active tenant slug ─────────────

buyerApiClient.interceptors.request.use(async (config) => {
  const [token, activeSellerRaw] = await Promise.all([
    storage.get(BUYER_KEYS.accessToken),
    storage.get(BUYER_KEYS.activeSeller),
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
      const refreshToken = await storage.get(BUYER_KEYS.refreshToken);
      if (!refreshToken) throw new Error("No buyer refresh token");

      const { data } = await axios.post<BuyerAuthResponse>(
        `${BASE_URL}/api/v1/buyer/auth/refresh`,
        { refreshToken },
      );
      await storage.set(BUYER_KEYS.accessToken, data.accessToken);
      await storage.set(BUYER_KEYS.refreshToken, data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return buyerApiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      await storage.del(BUYER_KEYS.accessToken);
      await storage.del(BUYER_KEYS.refreshToken);
      // BUG-B1-1: tell the session store the buyer is signed out so the root
      // layout redirects to /customer-login instead of leaving the buyer on a
      // screen whose every API call now silently fails with empty data.
      if (buyerSessionExpiredHandler) {
        try {
          buyerSessionExpiredHandler();
        } catch {
          /* ignore */
        }
      }
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

export async function buyerLogin(email: string, password: string): Promise<BuyerAuthResponse> {
  const { data } = await buyerApiClient.post<BuyerAuthResponse>("/buyer/auth/login", {
    email,
    password,
  });
  await storage.set(BUYER_KEYS.accessToken, data.accessToken);
  await storage.set(BUYER_KEYS.refreshToken, data.refreshToken);
  return data;
}

export async function buyerRegister(
  email: string,
  password: string,
  name: string,
): Promise<BuyerAuthResponse> {
  const { data } = await buyerApiClient.post<BuyerAuthResponse>("/buyer/auth/register", {
    email,
    password,
    name,
  });
  await storage.set(BUYER_KEYS.accessToken, data.accessToken);
  await storage.set(BUYER_KEYS.refreshToken, data.refreshToken);
  return data;
}

export async function buyerLogout(): Promise<void> {
  try {
    await buyerApiClient.post("/buyer/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless
  }
  // RF-077: only clear buyer-namespaced storage.
  await storage.del(BUYER_KEYS.accessToken);
  await storage.del(BUYER_KEYS.refreshToken);
  await storage.del(BUYER_KEYS.activeSeller);
}

export async function buyerRefreshTokens(): Promise<BuyerAuthResponse | null> {
  const refreshToken = await storage.get(BUYER_KEYS.refreshToken);
  if (!refreshToken) return null;
  try {
    const { data } = await buyerApiClient.post<BuyerAuthResponse>("/buyer/auth/refresh", {
      refreshToken,
    });
    await storage.set(BUYER_KEYS.accessToken, data.accessToken);
    await storage.set(BUYER_KEYS.refreshToken, data.refreshToken);
    return data;
  } catch {
    return null;
  }
}

export async function getStoredBuyer(): Promise<BuyerUser | null> {
  const token = await storage.get(BUYER_KEYS.accessToken);
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
  const raw = await storage.get(BUYER_KEYS.activeSeller);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuyerSeller;
  } catch {
    return null;
  }
}

export async function setActiveSeller(seller: BuyerSeller): Promise<void> {
  await storage.set(BUYER_KEYS.activeSeller, JSON.stringify(seller));
}

function parseQueryFromUrl(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.split("?")[1];
  if (!q) return out;
  for (const pair of q.split("&")) {
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}

const GOOGLE_REDIRECT_URI = "routeflow://auth/callback";

/**
 * Sign in to the buyer portal with Google (buyer-standalone context).
 * No tenant slug required — the backend auto-matches the buyer account by email.
 * Returns the buyer profile and how many sellers they are linked to.
 */
export async function buyerLoginWithGoogle(): Promise<{ buyer: BuyerUser; sellerCount: number }> {
  // Web (the mobile-web build) cannot use the native routeflow:// deep link — a
  // browser can't open a custom URL scheme, so openAuthSessionAsync never resolves
  // and sign-in silently hangs. Use the same full-page-redirect + one-time-code
  // exchange the operator web login (lib/auth.ts) uses: omit mobile=1 so the API
  // redirects to ${WEB_URL}/auth/google/callback?code=…, handled by
  // app/(auth)/auth/google/callback.tsx (which persists BUYER tokens by type).
  if (Platform.OS === "web") {
    const { data: web } = await axios.get<{ url: string }>(`${BASE_URL}/api/v1/auth/google`, {
      params: { context: "buyer-standalone" }, // no mobile=1 → web exchange-code flow
    });
    if (!web?.url) throw new Error("google_unavailable");
    if (typeof window !== "undefined") window.location.assign(web.url);
    // The page navigates away; the callback route finishes sign-in. Never resolves.
    return new Promise<{ buyer: BuyerUser; sellerCount: number }>(() => {});
  }

  const { data } = await axios.get<{ url: string }>(`${BASE_URL}/api/v1/auth/google`, {
    params: { context: "buyer-standalone", mobile: 1 },
  });
  if (!data?.url) throw new Error("google_unavailable");

  const result = await WebBrowser.openAuthSessionAsync(data.url, GOOGLE_REDIRECT_URI);
  if (result.type !== "success" || !result.url) {
    if (result.type === "cancel" || result.type === "dismiss") throw new Error("cancelled");
    throw new Error("google_unavailable");
  }

  const params = parseQueryFromUrl(result.url);
  if (params.error) throw new Error(params.error);
  const { accessToken, refreshToken, type } = params;
  if (!accessToken || !refreshToken || type !== "BUYER") throw new Error("google_token_invalid");

  await storage.set(BUYER_KEYS.accessToken, accessToken);
  await storage.set(BUYER_KEYS.refreshToken, refreshToken);

  const payload = parseJwtPayload(accessToken);
  const buyer: BuyerUser = {
    id: (payload?.sub as string) ?? "",
    email: (payload?.email as string) ?? "",
    name: (payload?.name as string) ?? "",
  };

  return { buyer, sellerCount: parseInt(params.sellerCount ?? "0", 10) };
}
