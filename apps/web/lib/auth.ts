import { apiClient } from "./api-client";
import { setTenantCookie, clearTenantCookie } from "./tenant-cookie";
import { OP_KEYS } from "./auth-keys";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  role: "OPERATOR" | "DRIVER" | "CUSTOMER" | "SUPER_ADMIN" | "TENANT_ADMIN";
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  forcePasswordChange: boolean;
  isAdmin?: boolean;
  canActAsDriver?: boolean;
  tenantSlug?: string | null;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// ─── Legacy key migration (NEW-m2-1 / RF-077) ────────────────────────────────

const LEGACY_ACCESS = "accessToken";
const LEGACY_REFRESH = "refreshToken";

/**
 * One-time migration: if the legacy `accessToken` key exists and holds an
 * operator/customer/admin role token, copy it to the namespaced key then
 * delete the legacy entry. Idempotent — safe to call on every page load.
 */
export function migrateLegacyOpToken(): void {
  if (typeof window === "undefined") return;
  const legacy = localStorage.getItem(LEGACY_ACCESS);
  if (!legacy) return;
  const payload = parseJwtPayload(legacy);
  const role = payload?.role as string | undefined;
  // Only migrate operator-flavoured tokens (driver tokens belong to rf:driver: slot)
  if (role && ["OPERATOR", "TENANT_ADMIN", "CUSTOMER", "SUPER_ADMIN"].includes(role)) {
    if (!localStorage.getItem(OP_KEYS.accessToken)) {
      localStorage.setItem(OP_KEYS.accessToken, legacy);
      const legacyRefresh = localStorage.getItem(LEGACY_REFRESH);
      if (legacyRefresh) localStorage.setItem(OP_KEYS.refreshToken, legacyRefresh);
    }
  }
  // Remove legacy keys regardless (avoids collisions going forward)
  localStorage.removeItem(LEGACY_ACCESS);
  localStorage.removeItem(LEGACY_REFRESH);
}

// ─── Token helpers ────────────────────────────────────────────────────────────

function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  // Prefer impersonation token when active, fall back to namespaced operator token
  const token = localStorage.getItem("impersonationToken") ?? localStorage.getItem(OP_KEYS.accessToken);
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  // Reject expired tokens client-side (server also validates)
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return null;
  }
  return {
    id: payload.sub as string,
    username: payload.username as string,
    role: payload.role as AuthUser["role"],
    status: payload.status as AuthUser["status"],
    forcePasswordChange: payload.forcePasswordChange as boolean,
    isAdmin: (payload.isAdmin as boolean) ?? false,
    canActAsDriver: (payload.canActAsDriver as boolean) ?? false,
    tenantSlug: (payload.tenantSlug as string) ?? localStorage.getItem("impersonationTenantSlug") ?? null,
  };
}

// ─── Auth functions ───────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", {
    username,
    password,
  });
  localStorage.setItem(OP_KEYS.accessToken, data.accessToken);
  localStorage.setItem(OP_KEYS.refreshToken, data.refreshToken);
  // Correct the tenant cookie to match the authenticated user's actual tenant.
  // This ensures that even if the browser had a stale cookie from a previous
  // session or impersonation, all subsequent API calls use the correct tenant.
  if (data.user.tenantSlug) {
    setTenantCookie(data.user.tenantSlug);
  }
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post("/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless of server response
  }
  localStorage.removeItem(OP_KEYS.accessToken);
  localStorage.removeItem(OP_KEYS.refreshToken);
  clearTenantCookie();
  window.location.href = "/login";
}

export async function refreshTokens(): Promise<AuthResponse | null> {
  const refreshToken = typeof window !== "undefined" ? localStorage.getItem(OP_KEYS.refreshToken) : null;
  if (!refreshToken) return null;
  try {
    const { data } = await apiClient.post<AuthResponse>("/auth/refresh", {
      refreshToken,
    });
    localStorage.setItem(OP_KEYS.accessToken, data.accessToken);
    localStorage.setItem(OP_KEYS.refreshToken, data.refreshToken);
    return data;
  } catch {
    return null;
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await apiClient.post("/auth/change-password", { currentPassword, newPassword });
}

// ─── Cross-tab isolation listener (NEW-m2-1 / RF-077) ────────────────────────
// If another tab removes the operator token (e.g. logs out), prompt re-auth
// in this tab too.

type ReauthCallback = () => void;

/**
 * Register a callback invoked when the operator token is removed by a sibling
 * tab. Returns an unsubscribe function. Call once from the root layout.
 */
export function onCrossTabTokenChange(cb: ReauthCallback): () => void {
  function handleStorageEvent(event: StorageEvent) {
    if (event.key === OP_KEYS.accessToken && event.storageArea === localStorage && !event.newValue) {
      cb();
    }
  }
  window.addEventListener("storage", handleStorageEvent);
  return () => window.removeEventListener("storage", handleStorageEvent);
}
