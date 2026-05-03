import { create } from "zustand";
import { Platform } from "react-native";
import {
  AuthUser,
  login as apiLogin,
  loginWithGoogle as apiLoginWithGoogle,
  logout as apiLogout,
  getStoredUser,
  refreshTokens,
} from "./auth";
import { OP_KEYS, DRIVER_KEYS, CURRENT_ROLE_KEY } from "./auth-keys";

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

      // BUG-XR1-3: cross-tab logout. When another tab clears the
      // operator/driver access token (or the role marker) via logout,
      // mirror the sign-out into this tab's in-memory state so the
      // root layout redirects to /login. Without this listener, tab B
      // stays authenticated indefinitely after tab A signs out.
      installCrossTabLogoutListener();
    } catch {
      set({ user: null, isAuthenticated: false, activeRole: null });
    } finally {
      set({ isLoading: false });
    }
  },
}));

let crossTabListenerInstalled = false;
function installCrossTabLogoutListener() {
  if (Platform.OS !== "web") return;
  if (crossTabListenerInstalled) return;
  if (typeof window === "undefined") return;
  crossTabListenerInstalled = true;
  const STAFF_TOKEN_KEYS = new Set<string>([
    OP_KEYS.accessToken,
    DRIVER_KEYS.accessToken,
    CURRENT_ROLE_KEY,
  ]);
  window.addEventListener("storage", (e: StorageEvent) => {
    // Only react when the change is a clear (newValue === null) of a key we care about.
    if (!e.key || e.newValue !== null) return;
    if (!STAFF_TOKEN_KEYS.has(e.key)) return;
    // The other tab signed out. Drop our in-memory user without calling
    // apiLogout() — the server already received the original logout.
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      activeRole: null,
    });
  });
}
