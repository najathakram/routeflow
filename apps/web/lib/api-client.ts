/**
 * Axios instance for all RouteFlow API calls.
 *
 * Security note: tokens are stored in localStorage for this MVP.
 * Phase 2 hardening: migrate to HttpOnly cookies to eliminate XSS exposure.
 */

import axios from "axios";
import { OP_KEYS, BUYER_KEYS } from "./auth-keys";
import { setOpPresenceCookie, clearOpPresenceCookie } from "./presence-cookies";
import { hasReauthHandler, requestReauth } from "./session-expiry";
import { parsePlanGate, type PlanGateBody } from "./plan-gate";
import { getImpersonation, clearImpersonation } from "./impersonation";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

export const apiClient = axios.create({
  baseURL: BASE_URL,
  // Serialize array params as repeated keys (?statuses=A&statuses=B) instead of
  // axios's default bracket notation (?statuses[]=A&statuses[]=B). Express's
  // `simple` query parser doesn't unwrap brackets, so the API sees the literal
  // key "statuses[]" and the global ValidationPipe (forbidNonWhitelisted) 400s.
  // Mirrors `buyerApiClient` in apps/mobile/lib/buyer-auth.ts.
  paramsSerializer: { indexes: null },
});

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

/**
 * Platform-admin surfaces (`/admin`, `/admin-login`, …). These pages are owned
 * by `superAdminClient` (lib/admin-api.ts), which keeps its OWN token pair and
 * redirects to `/admin-login` on its own auth failure. This operator client
 * must therefore never redirect away from them: a super admin routinely has a
 * stale (or absent) operator token — and often a buyer session in the same
 * browser — so a background operator call 401'ing here used to bounce a
 * perfectly valid admin session to `/buyer/login` or `/login`, seemingly at
 * random. The trigger is idle time: TanStack Query refetches on window focus,
 * so returning to an idle admin tab fired exactly that request.
 */
function isOnSuperAdminRoute(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/admin");
}

/** Operator surfaces only — the in-place re-auth sheet must never appear over
 *  the buyer portal, the platform-admin panel, or the auth pages (a stale
 *  operator token can coexist with a buyer or super-admin session, RF-220).
 *  Buyer/marketing keep the redirect fallback. */
function isOperatorSurface(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  if (isOnMarketingRoute()) return false;
  if (isOnSuperAdminRoute()) return false;
  if (path.startsWith("/buyer") || path === "/login") return false;
  return true;
}

// ─── Request interceptor: attach access token + tenant slug ──────────────────

apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const imp = getImpersonation();
    // An EXPIRED impersonation token must never fall through to the operator
    // token — that silently switches identities. End the impersonation instead.
    if (imp?.expired) {
      clearImpersonation();
      if (!window.location.pathname.startsWith("/admin")) {
        window.location.assign("/admin/tenants?impersonation=expired");
      }
    }
    const active = imp && !imp.expired ? imp : null;
    const token = active?.token ?? localStorage.getItem(OP_KEYS.accessToken);
    if (token) config.headers.Authorization = `Bearer ${token}`;
    const slug = active?.slug ?? getTenantSlugFromCookie();
    if (slug) config.headers["X-Tenant-Slug"] = slug;
  }
  return config;
});

// ─── PLAN_GATE notice bridge ──────────────────────────────────────────────────

/**
 * `PlanGateNotice` (components/PlanGateNotice.tsx) registers itself here on
 * mount, mirroring the reauth bridge in session-expiry.ts. When a gated GET
 * 403s with a PLAN_GATE body, the response interceptor below notifies the
 * listener so it can surface a friendly toast (message + upgrade hint)
 * instead of the query failing silently. No-op if nothing is mounted.
 *
 * Mutations are NOT routed through this bridge: `MutationCache.onError` in
 * app/providers.tsx already toasts every mutation error's `message` (PLAN_GATE
 * bodies included) — notifying here too would double-toast the same failure.
 * That existing toast doesn't include the upgrade hint; extending it is out of
 * scope for this file (see WP5 notes).
 */
let planGateListener: ((gate: PlanGateBody) => void) | null = null;

export function registerPlanGateListener(fn: (gate: PlanGateBody) => void): () => void {
  planGateListener = fn;
  return () => {
    if (planGateListener === fn) planGateListener = null;
  };
}

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
    // PLAN_FLAG_ENFORCEMENT gate 403s (GET only — see the bridge comment above
    // for why mutations are excluded). Fire-and-continue: this never changes
    // the rejection below, it only surfaces a notice alongside it.
    const gate = parsePlanGate(error);
    if (gate && error.config?.method?.toLowerCase() === "get") {
      planGateListener?.(gate);
    }

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

    if (typeof window !== "undefined" && getImpersonation()) {
      // An impersonation token is not refreshable — retrying the operator
      // refresh flow here would silently switch who the user is. End the
      // impersonation instead.
      clearImpersonation();
      if (!window.location.pathname.startsWith("/admin")) {
        window.location.assign("/admin/tenants?impersonation=expired");
      }
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
      // Sliding presence window — the middleware's landing-page redirect keys
      // on this cookie, so it must track the live session (presence-cookies.ts).
      setOpPresenceCookie();

      original.headers.Authorization = `Bearer ${data.accessToken}`;
      processQueue(null, data.accessToken);
      return apiClient(original);
    } catch (refreshError) {
      // Concurrent-refresh race: another request/tab may have already rotated
      // the pair. If a fresh access token exists that differs from the one
      // this request sent, retry with it instead of declaring the session
      // dead. isRefreshing resets in the finally block below, same as every
      // other exit path through this catch.
      const raced =
        typeof window !== "undefined" ? localStorage.getItem(OP_KEYS.accessToken) : null;
      const sent = String(original.headers.Authorization ?? "").replace(/^Bearer\s+/, "");
      if (raced && raced !== sent) {
        original.headers.Authorization = `Bearer ${raced}`;
        processQueue(null, raced);
        return apiClient(original);
      }

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
      // Dead session → drop the presence signal so the landing page stops
      // auto-redirecting (the stale-cookie bounce that killed the old
      // client-side redirect).
      clearOpPresenceCookie();
      // Don't punt the user off a marketing route just because a background
      // API call 401'd against a stale token — let them keep browsing the
      // marketing site. Tokens are now cleared, so the next dashboard click
      // will go through the normal login flow.
      //
      // Same for the platform-admin panel, for a stronger reason: that session
      // lives in a DIFFERENT token pair (superAdminClient) which is still
      // perfectly valid, so redirecting here would evict a signed-in super
      // admin over an unrelated operator 401 — landing them on `/buyer/login`
      // whenever they also had a buyer session (the same Google account can be
      // both), or `/login` otherwise. That is the intermittent "my admin page
      // switches me to the buyer/sign-in page after idling" bug: nothing about
      // the admin session expired, and superAdminClient handles its own 401s.
      if (!isOnMarketingRoute() && !isOnSuperAdminRoute()) {
        window.location.href = buyerToken && !opToken ? "/buyer/login" : "/login";
      }
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);
