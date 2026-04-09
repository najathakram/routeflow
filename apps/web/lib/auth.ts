import { apiClient } from "./api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  role: "OPERATOR" | "DRIVER" | "CUSTOMER" | "SUPER_ADMIN" | "TENANT_ADMIN";
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

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  // Prefer impersonation token when active, fall back to regular access token
  const token = localStorage.getItem("impersonationToken") ?? localStorage.getItem("accessToken");
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
  localStorage.setItem("accessToken", data.accessToken);
  localStorage.setItem("refreshToken", data.refreshToken);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post("/auth/logout");
  } catch {
    // Best-effort — clear tokens regardless of server response
  }
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  window.location.href = "/login";
}

export async function refreshTokens(): Promise<AuthResponse | null> {
  const refreshToken =
    typeof window !== "undefined" ? localStorage.getItem("refreshToken") : null;
  if (!refreshToken) return null;
  try {
    const { data } = await apiClient.post<AuthResponse>("/auth/refresh", {
      refreshToken,
    });
    localStorage.setItem("accessToken", data.accessToken);
    localStorage.setItem("refreshToken", data.refreshToken);
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
