import { create } from "zustand";
import {
  AuthUser,
  login as apiLogin,
  loginWithGoogle as apiLoginWithGoogle,
  logout as apiLogout,
  getStoredUser,
  refreshTokens,
} from "./auth";

export type ActiveRole = "driver" | "operator" | null;

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Active role for dual-role users (e.g. an operator who also drives).
   * Defaults to the user's JWT role. Can be overridden from the role
   * picker. Null when no user is logged in.
   */
  activeRole: ActiveRole;
  login: (username: string, password: string) => Promise<AuthUser>;
  loginWithGoogle: (tenantSlug: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  setActiveRole: (role: ActiveRole) => void;
  initialize: () => Promise<void>;
}

function defaultRoleForUser(user: AuthUser | null): ActiveRole {
  if (!user) return null;
  if (user.role === "DRIVER") return "driver";
  if (user.role === "OPERATOR" || user.role === "TENANT_ADMIN") return "operator";
  return null;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  activeRole: null,

  login: async (username, password) => {
    const response = await apiLogin(username, password);
    set({
      user: response.user,
      isAuthenticated: true,
      activeRole: defaultRoleForUser(response.user),
    });
    return response.user;
  },

  loginWithGoogle: async (tenantSlug) => {
    const response = await apiLoginWithGoogle(tenantSlug);
    set({
      user: response.user,
      isAuthenticated: true,
      activeRole: defaultRoleForUser(response.user),
    });
    return response.user;
  },

  logout: async () => {
    await apiLogout();
    set({ user: null, isAuthenticated: false, activeRole: null });
  },

  setUser: (user) =>
    set({ user, isAuthenticated: user !== null, activeRole: defaultRoleForUser(user) }),

  setActiveRole: (role) => set({ activeRole: role }),

  initialize: async () => {
    set({ isLoading: true });
    try {
      let user = await getStoredUser();
      if (!user) {
        const refreshed = await refreshTokens();
        user = refreshed?.user ?? null;
      }
      set({
        user,
        isAuthenticated: user !== null,
        activeRole: defaultRoleForUser(user),
      });
    } catch {
      set({ user: null, isAuthenticated: false, activeRole: null });
    } finally {
      set({ isLoading: false });
    }
  },
}));
