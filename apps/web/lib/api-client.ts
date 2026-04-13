/**
 * Axios instance for all RouteFlow API calls.
 *
 * Security note: tokens are stored in localStorage for this MVP.
 * Phase 2 hardening: migrate to HttpOnly cookies to eliminate XSS exposure.
 */

import axios from "axios";

const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

export const apiClient = axios.create({ baseURL: BASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read the tenant-slug cookie set by the Next.js middleware.
 *  Falls back to NEXT_PUBLIC_DEFAULT_TENANT for single-tenant deployments. */
function getTenantSlugFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : (process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? null);
}

// ─── Request interceptor: attach access token + tenant slug ──────────────────

apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    // Prefer impersonation token over regular access token when present
    const impersonationToken = localStorage.getItem("impersonationToken");
    const token = impersonationToken || localStorage.getItem("accessToken");
    if (token) config.headers.Authorization = `Bearer ${token}`;

    // Tell the API which tenant this request belongs to.
    // Prefer the impersonation slug (set when super admin impersonates a tenant)
    // over the cookie, as defense-in-depth against stale cookies.
    const impersonationSlug = localStorage.getItem("impersonationTenantSlug");
    const slug = impersonationSlug || getTenantSlugFromCookie();
    if (slug) config.headers["X-Tenant-Slug"] = slug;
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

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as typeof error.config & {
      _retry?: boolean;
    };

    // Never attempt refresh for auth endpoints — let the caller handle the error
    if (
      error.response?.status !== 401 ||
      original._retry ||
      original.url?.includes("/auth/login") ||
      original.url?.includes("/auth/refresh") ||
      original.url?.includes("/auth/logout")
    ) {
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
      const refreshToken =
        typeof window !== "undefined"
          ? localStorage.getItem("refreshToken")
          : null;
      if (!refreshToken) throw new Error("No refresh token");

      const { data } = await axios.post(`${BASE_URL}/auth/refresh`, {
        refreshToken,
      });
      localStorage.setItem("accessToken", data.accessToken);
      localStorage.setItem("refreshToken", data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return apiClient(original);
    } catch (refreshError) {
      processQueue(refreshError, null);
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      window.location.href = "/login";
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
