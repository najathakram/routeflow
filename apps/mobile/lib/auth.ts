import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
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
