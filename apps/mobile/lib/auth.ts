import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as WebBrowser from "expo-web-browser";
import { apiClient } from "./api-client";

// ─── Web-safe storage (SecureStore is native-only) ────────────────────────────

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return localStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") { localStorage.setItem(key, value); return; }
    await SecureStore.setItemAsync(key, value);
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === "web") { localStorage.removeItem(key); return; }
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

export async function getStoredUser(): Promise<AuthUser | null> {
  const token = await storage.get("accessToken");
  if (!token) return null;
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    return null;
  }
  return {
    id: payload.sub as string,
    username: payload.username as string,
    role: payload.role as AuthUser["role"],
    status: payload.status as AuthUser["status"],
    forcePasswordChange: payload.forcePasswordChange as boolean,
  };
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

export async function login(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", {
    username,
    password,
  });
  await storage.set("accessToken", data.accessToken);
  await storage.set("refreshToken", data.refreshToken);
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

  await storage.set("accessToken", accessToken);
  await storage.set("refreshToken", refreshToken);

  // Decode the user from the JWT — same shape getStoredUser returns
  const payload = parseJwtPayload(accessToken);
  const user: AuthUser = {
    id: (payload?.sub as string) ?? "",
    username: (payload?.username as string) ?? "",
    role: ((payload?.role as AuthUser["role"]) ?? (role as AuthUser["role"])),
    status: (payload?.status as AuthUser["status"]) ?? "ACTIVE",
    forcePasswordChange: (payload?.forcePasswordChange as boolean) ?? false,
  };

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
  await storage.del("accessToken");
  await storage.del("refreshToken");
}

export async function refreshTokens(): Promise<AuthResponse | null> {
  const refreshToken = await storage.get("refreshToken");
  if (!refreshToken) return null;
  try {
    const { data } = await apiClient.post<AuthResponse>("/auth/refresh", {
      refreshToken,
    });
    await storage.set("accessToken", data.accessToken);
    await storage.set("refreshToken", data.refreshToken);
    return data;
  } catch {
    return null;
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await apiClient.post("/auth/change-password", { currentPassword, newPassword });
}
