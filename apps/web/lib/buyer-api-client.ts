import axios from "axios";
import type { BuyerSeller } from "./buyer-auth";
import { BUYER_KEYS } from "./auth-keys";

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1").replace(
  /\/$/,
  "",
);

export const buyerApiClient = axios.create({ baseURL: BASE_URL });

// ─── Request interceptor: attach buyer access token + X-Tenant-Slug ──────────
//
// RF-220 / NEW-m2-1 TOKEN ISOLATION: this client reads ONLY rf:buyer:* keys.
// The operator portal stores its JWT under rf:op:* keys.
// Never read rf:op:* here — that would allow cross-context token bleed when
// the same browser session has both an operator and a buyer session open.

buyerApiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem(BUYER_KEYS.accessToken);
    if (token) config.headers.Authorization = `Bearer ${token}`;

    const raw = localStorage.getItem(BUYER_KEYS.activeSeller);
    if (raw) {
      try {
        const seller: BuyerSeller = JSON.parse(raw);
        if (seller?.tenant?.slug) config.headers["X-Tenant-Slug"] = seller.tenant.slug;
      } catch {
        /* ignore */
      }
    }
  }
  return config;
});

// ─── Response interceptor: refresh on 401 ────────────────────────────────────

let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

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
    const original = error.config as typeof error.config & { _retry?: boolean };
    if (error.response?.status !== 401 || original._retry) return Promise.reject(error);

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
      const refreshToken =
        typeof window !== "undefined" ? localStorage.getItem(BUYER_KEYS.refreshToken) : null;
      if (!refreshToken) throw new Error("No buyer refresh token");

      const { data } = await axios.post(`${BASE_URL}/buyer/auth/refresh`, { refreshToken });
      localStorage.setItem(BUYER_KEYS.accessToken, data.accessToken);
      localStorage.setItem(BUYER_KEYS.refreshToken, data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return buyerApiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      localStorage.removeItem(BUYER_KEYS.accessToken);
      localStorage.removeItem(BUYER_KEYS.refreshToken);
      localStorage.removeItem(BUYER_KEYS.activeSeller);
      // Only bounce to the buyer login when the viewer is actually IN the buyer
      // portal. The same browser routinely holds a staff or super-admin session
      // too (the same Google account can be both), each with its own token pair
      // and its own 401 handling — so redirecting from a `/dashboard` or
      // `/admin` page would evict a perfectly valid session because an
      // unrelated buyer token went stale. The tokens are cleared either way, so
      // the next buyer-portal visit goes through the normal login flow.
      if (typeof window !== "undefined" && window.location.pathname.startsWith("/buyer")) {
        window.location.href = "/buyer/login";
      }
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
