import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as WebBrowser from "expo-web-browser";
import { apiClient } from "./api-client";
import { OP_KEYS, DRIVER_KEYS, BUYER_KEYS, CURRENT_ROLE_KEY, type CurrentRole } from "./auth-keys";
import { setLastUsername } from "./last-username";

// ─── Web-safe storage (SecureStore is native-only) ────────────────────────────

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === "web") {
      localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  role: "OPERATOR" | "TENANT_ADMIN" | "DRIVER" | "CUSTOMER" | "SUPER_ADMIN";
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  forcePasswordChange: boolean;
  isAdmin: boolean;
  canActAsDriver: boolean;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
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

const DRIVER_ROLE_SET = new Set(["DRIVER"]);

function keysForRole(role: string): typeof OP_KEYS | typeof DRIVER_KEYS {
  return DRIVER_ROLE_SET.has(role) ? DRIVER_KEYS : OP_KEYS;
}

function currentRoleFromJwtRole(role: string): CurrentRole {
  return DRIVER_ROLE_SET.has(role) ? "driver" : "operator";
}

// ─── Legacy key migration (NEW-m2-1 / RF-077) ────────────────────────────────

const LEGACY_ACCESS = "accessToken";
const LEGACY_REFRESH = "refreshToken";

/**
 * One-time migration: if the legacy `accessToken` key exists, move it to the
 * role-appropriate namespaced key then delete the legacy entry. Idempotent.
 */
export async function migrateLegacyToken(): Promise<void> {
  const legacy = await storage.get(LEGACY_ACCESS);
  if (!legacy) return;

  const payload = parseJwtPayload(legacy);
  const role = (payload?.role as string) ?? "";
  const keys = keysForRole(role);

  const existing = await storage.get(keys.accessToken);
  if (!existing) {
    await storage.set(keys.accessToken, legacy);
    const legacyRefresh = await storage.get(LEGACY_REFRESH);
    if (legacyRefresh) await storage.set(keys.refreshToken, legacyRefresh);
  }
  await storage.del(LEGACY_ACCESS);
  await storage.del(LEGACY_REFRESH);
}

function authUserFromToken(token: string): AuthUser | null {
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  return {
    id: payload.sub as string,
    username: payload.username as string,
    role: payload.role as AuthUser["role"],
    status: payload.status as AuthUser["status"],
    forcePasswordChange: payload.forcePasswordChange as boolean,
    isAdmin: (payload.isAdmin as boolean) ?? false,
    canActAsDriver: (payload.canActAsDriver as boolean) ?? false,
  };
}

/**
 * Get the stored staff user from the appropriate role bucket.
 *
 * BUG-XR1-4: prefer the bucket explicitly marked as the current role, falling
 * back to operator-then-driver iteration only when the marker is missing
 * (legacy sessions seeded before this change). Iteration order alone is not
 * enough — an expired operator token would otherwise let a stale driver token
 * "hijack" the session and route a re-logged-in operator to /route.
 */
export async function getStoredUser(): Promise<AuthUser | null> {
  const marker = (await storage.get(CURRENT_ROLE_KEY)) as CurrentRole | null;
  if (marker === "operator" || marker === "driver") {
    const keys = marker === "driver" ? DRIVER_KEYS : OP_KEYS;
    const token = await storage.get(keys.accessToken);
    if (token) {
      const user = authUserFromToken(token);
      if (user) return user;
    }
    // Marker pointed to a bucket whose token is missing/expired — fall
    // through to the iteration so we don't silently strand the user.
  }
  for (const keySet of [OP_KEYS, DRIVER_KEYS]) {
    const token = await storage.get(keySet.accessToken);
    if (!token) continue;
    const user = authUserFromToken(token);
    if (user) return user;
  }
  return null;
}

// ─── Auth functions ───────────────────────────────────────────────────────────

async function registerPushToken(): Promise<void> {
  // Expo push token only works on physical device (not simulator)
  if (Platform.OS === "web") return;
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return;

    const { data: token } = await Notifications.getExpoPushTokenAsync();
    if (!token) return;

    await storage.set("pushToken", token);
    await apiClient.post("/notifications/register-token", {
      token,
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
    });
  } catch {
    // Best-effort — don't block login on push token failure
  }
}

async function deregisterPushToken(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const token = await storage.get("pushToken");
    if (!token) return;
    await apiClient.delete(`/notifications/token/${encodeURIComponent(token)}`);
    await storage.del("pushToken");
  } catch {
    // Best-effort
  }
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", {
    username,
    password,
  });
  const keys = keysForRole(data.user.role);
  await storage.set(keys.accessToken, data.accessToken);
  await storage.set(keys.refreshToken, data.refreshToken);
  // BUG-XR1-4: pin the active role so subsequent reads target the right bucket.
  await storage.set(CURRENT_ROLE_KEY, currentRoleFromJwtRole(data.user.role));
  await setLastUsername(data.user.username);
  // Register push token after successful login
  await registerPushToken();
  return data;
}

const GOOGLE_REDIRECT_URI = "routeflow://auth/callback";

/**
 * Sign in with Google. Flow:
 *   1. Ask the API for a Google consent URL tied to the current tenant slug.
 *   2. Open it in an in-app browser (ASWebAuthenticationSession / Custom Tabs / popup).
 *   3. Server redirects to routeflow://auth/callback?accessToken=…&refreshToken=…
 *   4. Parse the tokens out of the resolved URL, persist them, register push token.
 */
export async function loginWithGoogle(tenantSlug: string): Promise<AuthResponse> {
  // Web (the mobile-web build phones are proxied to) cannot use the native
  // routeflow:// deep-link flow — a browser can't open a custom URL scheme, so the
  // sign-in silently hangs. Use the same full-page-redirect + one-time-code exchange
  // the desktop web uses: the API redirects to ${WEB_URL}/auth/google/callback?code=…,
  // handled by app/(auth)/auth/google/callback.tsx.
  if (Platform.OS === "web") {
    const { data: web } = await apiClient.get<{ url: string }>("/auth/google", {
      params: { tenant: tenantSlug, context: "staff" }, // no mobile=1 → web exchange-code flow
    });
    if (!web?.url) throw new Error("google_unavailable");
    window.location.assign(web.url); // full-page redirect to Google consent
    // The page navigates away; the callback route finishes sign-in. Never resolves.
    return new Promise<AuthResponse>(() => {});
  }

  // Native (installed iOS/Android app) — deep-link flow.
  // Step 1 — get consent URL from API (no auth required; tenant slug scopes the flow)
  const { data } = await apiClient.get<{ url: string }>("/auth/google", {
    params: { tenant: tenantSlug, context: "staff", mobile: 1 },
  });
  if (!data?.url) throw new Error("google_unavailable");

  // Step 2 — open Google consent in a system web browser
  const result = await WebBrowser.openAuthSessionAsync(data.url, GOOGLE_REDIRECT_URI);
  if (result.type !== "success" || !result.url) {
    if (result.type === "cancel" || result.type === "dismiss") throw new Error("cancelled");
    throw new Error("google_unavailable");
  }

  // Step 3 — parse tokens out of the callback URL (routeflow://auth/callback?accessToken=…)
  const params = parseQueryFromUrl(result.url);
  if (params.error) throw new Error(params.error);
  const { accessToken, refreshToken, role, tenantSlug: resolvedTenantSlug } = params;
  if (!accessToken || !refreshToken) throw new Error("google_token_invalid");

  const keys = keysForRole(role ?? "OPERATOR");
  await storage.set(keys.accessToken, accessToken);
  await storage.set(keys.refreshToken, refreshToken);
  // BUG-XR1-4: pin the active role for the same reason as the password login path.
  await storage.set(CURRENT_ROLE_KEY, currentRoleFromJwtRole(role ?? "OPERATOR"));

  // Decode the user from the JWT — same shape getStoredUser returns
  const payload = parseJwtPayload(accessToken);
  const user: AuthUser = {
    id: (payload?.sub as string) ?? "",
    username: (payload?.username as string) ?? "",
    role: (payload?.role as AuthUser["role"]) ?? (role as AuthUser["role"]),
    status: (payload?.status as AuthUser["status"]) ?? "ACTIVE",
    forcePasswordChange: (payload?.forcePasswordChange as boolean) ?? false,
    isAdmin: (payload?.isAdmin as boolean) ?? false,
    canActAsDriver: (payload?.canActAsDriver as boolean) ?? false,
  };

  await setLastUsername(user.username);
  await registerPushToken();

  return {
    accessToken,
    refreshToken,
    user,
    // Present in AuthResponse for parity with /auth/login — caller can ignore
    ...(resolvedTenantSlug ? { tenantSlug: resolvedTenantSlug } : {}),
  } as AuthResponse;
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

export async function logout(): Promise<void> {
  // Deregister push token before logging out
  await deregisterPushToken();
  try {
    await apiClient.post("/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless of server response
  }
  // BUG-XR1-2 / audit-cluster: clear EVERY role bucket on staff logout,
  // including buyer slots and the active-seller pointer. The previous code
  // left rf:buyer:accessToken in localStorage, which let useBuyerSocket
  // open an orphan WebSocket under the next operator's session.
  await storage.del(OP_KEYS.accessToken);
  await storage.del(OP_KEYS.refreshToken);
  await storage.del(DRIVER_KEYS.accessToken);
  await storage.del(DRIVER_KEYS.refreshToken);
  await storage.del(BUYER_KEYS.accessToken);
  await storage.del(BUYER_KEYS.refreshToken);
  await storage.del(BUYER_KEYS.activeSeller);
  await storage.del(CURRENT_ROLE_KEY);
}

export async function refreshTokens(): Promise<AuthResponse | null> {
  // Prefer the bucket matching the active-role marker; fall back to
  // op-then-driver iteration for legacy sessions.
  const marker = (await storage.get(CURRENT_ROLE_KEY)) as CurrentRole | null;
  const order =
    marker === "driver"
      ? [DRIVER_KEYS, OP_KEYS]
      : marker === "operator"
        ? [OP_KEYS, DRIVER_KEYS]
        : [OP_KEYS, DRIVER_KEYS];
  for (const keys of order) {
    const refreshToken = await storage.get(keys.refreshToken);
    if (!refreshToken) continue;
    try {
      const { data } = await apiClient.post<AuthResponse>("/auth/refresh", {
        refreshToken,
      });
      const newKeys = keysForRole(data.user.role);
      await storage.set(newKeys.accessToken, data.accessToken);
      await storage.set(newKeys.refreshToken, data.refreshToken);
      await storage.set(CURRENT_ROLE_KEY, currentRoleFromJwtRole(data.user.role));
      return data;
    } catch {
      // Try next slot
    }
  }
  return null;
}

/** The server revokes every refresh token on a password mutation and returns a
 *  fresh pair — store it so THIS session survives instead of dying at the next
 *  refresh. */
async function storeRotatedPair(data: { accessToken?: string; refreshToken?: string }) {
  if (!data.accessToken || !data.refreshToken) return;
  const payload = parseJwtPayload(data.accessToken);
  const role = (payload?.role as string) ?? "OPERATOR";
  const keys = keysForRole(role);
  await storage.set(keys.accessToken, data.accessToken);
  await storage.set(keys.refreshToken, data.refreshToken);
  await storage.set(CURRENT_ROLE_KEY, currentRoleFromJwtRole(role));
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const { data } = await apiClient.post<{ accessToken?: string; refreshToken?: string }>(
    "/auth/change-password",
    { currentPassword, newPassword },
  );
  await storeRotatedPair(data);
}

/**
 * First-password setup for Google-only accounts (no current password). The
 * server only accepts this while the account's password is NULL.
 */
export async function setPassword(newPassword: string): Promise<void> {
  const { data } = await apiClient.post<{ accessToken?: string; refreshToken?: string }>(
    "/auth/set-password",
    { newPassword },
  );
  await storeRotatedPair(data);
}
