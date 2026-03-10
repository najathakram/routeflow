import * as SecureStore from "expo-secure-store";
import { apiClient } from "./api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  role: "OPERATOR" | "DRIVER" | "CUSTOMER";
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
  const token = await SecureStore.getItemAsync("accessToken");
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

export async function login(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", {
    username,
    password,
  });
  await SecureStore.setItemAsync("accessToken", data.accessToken);
  await SecureStore.setItemAsync("refreshToken", data.refreshToken);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post("/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless of server response
  }
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
}

export async function refreshTokens(): Promise<AuthResponse | null> {
  const refreshToken = await SecureStore.getItemAsync("refreshToken");
  if (!refreshToken) return null;
  try {
    const { data } = await apiClient.post<AuthResponse>("/auth/refresh", {
      refreshToken,
    });
    await SecureStore.setItemAsync("accessToken", data.accessToken);
    await SecureStore.setItemAsync("refreshToken", data.refreshToken);
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
