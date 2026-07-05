/**
 * Axios instance for all RouteFlow API calls.
 *
 * Security note: tokens are stored in localStorage for this MVP.
 * Phase 2 hardening: migrate to HttpOnly cookies to eliminate XSS exposure.
 */

import axios from "axios";
import { OP_KEYS, BUYER_KEYS } from "./auth-keys";
import { hasReauthHandler, requestReauth } from "./session-expiry";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

export const apiClient = axios.create({ baseURL: BASE_URL });

/** Read the username from the operator access token payload, even if expired
 *  (used to label the re-auth sheet). Returns null if unreadable. */
function usernameFromOpToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(OP_KEYS.accessToken);
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return (payload?.username as string) ?? null;
  } catch {
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read the tenant-slug cookie set by the Next.js middleware or login form. */
function getTenantSlugFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Public marketing routes — these must NEVER be redirected to /login when a
 *  background API call 401s. Stale localStorage tokens are common (sessions
 *  expire; tokens linger), and a stray 401 should clear those tokens silently
 *  rather than punting the visitor off the marketing site they came to see. */
const MARKETING_ROUTES = new Set([
  "/",
  "/retailers",
  "/wholesalers",
  "/distributors",
  "/buyer",
  "/product",
  "/pricing",
  "/company",
  "/contact",
]);

function isOnMarketingRoute(): boolean {
  if (typeof window === "undefined") return false;
  return MARKETING_ROUTES.has(window.location.pathname);
}

/** Operator surfaces only — the in-place re-auth sheet must never appear over
 *  the buyer portal or the auth pages (a stale operator token can coexist with
 *  a buyer session, RF-220). Buyer/marketing keep the redirect fallback. */
function isOperatorSurface(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  if (isOnMarketingRoute()) return false;
  if (path.startsWith("/buyer") || path === "/login" || path === "/admin-login") return false;
  return true;
}

// ─── Request interceptor: attach access token + tenant slug ──────────────────

apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    // Prefer impersonation token over regular access token when present
    const impersonationToken = localStorage.getItem("impersonationToken");
    const token = impersonationToken || localStorage.getItem(OP_KEYS.accessToken);
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
        typeof window !== "undefined" ? localStorage.getItem(OP_KEYS.refreshToken) : null;
      if (!refreshToken) throw new Error("No refresh token");

      const { data } = await axios.post(`${BASE_URL}/auth/refresh`, {
        refreshToken,
      });
      localStorage.setItem(OP_KEYS.accessToken, data.accessToken);
      localStorage.setItem(OP_KEYS.refreshToken, data.refreshToken);

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return apiClient(original);
    } catch (refreshError) {
      // Refresh failed. Before bouncing to /login (which discards drafts),
      // offer an in-place re-auth sheet when one is mounted (operator surfaces).
      // The failed request stays queued until the user unlocks or declines.
      const username = usernameFromOpToken();
      if (isOperatorSurface() && username && hasReauthHandler()) {
        try {
          const unlocked = await requestReauth({ username });
          if (unlocked) {
            const fresh = localStorage.getItem(OP_KEYS.accessToken);
            if (fresh) {
              original.headers.Authorization = `Bearer ${fresh}`;
              processQueue(null, fresh);
              return apiClient(original);
            }
          }
        } catch {
          // fall through to the redirect below
        }
      }
      // Gave up (declined / no sheet mounted): clear tokens and redirect.
      processQueue(refreshError, null);
      const buyerToken = localStorage.getItem(BUYER_KEYS.accessToken);
      const opToken = localStorage.getItem(OP_KEYS.accessToken);
      localStorage.removeItem(OP_KEYS.accessToken);
      localStorage.removeItem(OP_KEYS.refreshToken);
      // Don't punt the user off a marketing route just because a background
      // API call 401'd against a stale token — let them keep browsing the
      // marketing site. Tokens are now cleared, so the next dashboard click
      // will go through the normal login flow.
      if (!isOnMarketingRoute()) {
        window.location.href = buyerToken && !opToken ? "/buyer/login" : "/login";
      }
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
