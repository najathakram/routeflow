import axios from "axios";
import type { BuyerSeller } from "./buyer-auth";

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1").replace(/\/$/, "");

export const buyerApiClient = axios.create({ baseURL: BASE_URL });

// ─── Request interceptor: attach buyer access token + X-Tenant-Slug ──────────

buyerApiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("buyerAccessToken");
    if (token) config.headers.Authorization = `Bearer ${token}`;

    const raw = localStorage.getItem("buyerActiveSeller");
    if (raw) {
      try {
        const seller: BuyerSeller = JSON.parse(raw);
        if (seller?.tenant?.slug) config.headers["X-Tenant-Slug"] = seller.tenant.slug;
      } catch { /* ignore */ }
    }
  }
  return config;
});

// ─── Response interceptor: refresh on 401 ────────────────────────────────────

let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach((p) => { if (error) p.reject(error); else p.resolve(token!); });
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
      const refreshToken = typeof window !== "undefined" ? localStorage.getItem("buyerRefreshToken") : null;
      if (!refreshToken) throw new Error("No buyer refresh token");

      const { data } = await axios.post(`${BASE_URL}/buyer/auth/refresh`, { refreshToken });
      localStorage.setItem("buyerAccessToken", data.accessToken);
      localStorage.setItem("buyerRefreshToken", data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return buyerApiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      localStorage.removeItem("buyerAccessToken");
      localStorage.removeItem("buyerRefreshToken");
      localStorage.removeItem("buyerActiveSeller");
      if (typeof window !== "undefined") window.location.href = "/buyer/login";
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
