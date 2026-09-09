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
import { registerStaffSessionExpiredHandler } from "./api-client";
import { teardownUserSession } from "./session-teardown";
import { rehydrateUserScopedStores } from "./session-hydrate";

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

export const useAuthStore = create<AuthState>((set, get) => ({
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
    // D3 (cause-ruling.md §3 / REG-B136): the user-scoped persisted stores
    // skip automatic hydration — their AsyncStorage key is resolved from the
    // signed-in user id, which only exists once the tokens are stored. Pull
    // this user's POD/settlement scratchpad in now.
    await rehydrateUserScopedStores();
    return response.user;
  },

  loginWithGoogle: async (tenantSlug) => {
    const response = await apiLoginWithGoogle(tenantSlug);
    set({
      user: response.user,
      isAuthenticated: true,
      activeRole: defaultRoleForUser(response.user),
    });
    // D3 (cause-ruling.md §3 / REG-B136): same as login() — the native Google
    // flow returns here without an app reload, so this is the only hydration
    // point for the user-scoped POD/settlement stores on this sign-in path.
    await rehydrateUserScopedStores();
    return response.user;
  },

  logout: async () => {
    // D1 (cause-ruling.md §3): tear down GPS/query-cache/user-scoped-store
    // state BEFORE apiLogout() — tokens are still valid at this point, so
    // the teardown itself can't be interrupted by a now-401'd request.
    try {
      await teardownUserSession({ reason: "logout", userId: get().user?.id ?? null });
    } catch {
      // Teardown must never block sign-out: a failure here still falls through
      // to apiLogout() and the state clear below.
    }
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

      // D3 (cause-ruling.md §3 / REG-B136): relaunch path. Same reason as
      // login() — hydrate the user-scoped stores only once the stored user is
      // known, so a POD capture written under this user's key comes back.
      if (user) await rehydrateUserScopedStores();

      // BUG-XR1-3: cross-tab logout. When another tab clears the
      // operator/driver access token (or the role marker) via logout,
      // mirror the sign-out into this tab's in-memory state so the
      // root layout redirects to /login. Without this listener, tab B
      // stays authenticated indefinitely after tab A signs out.
      installCrossTabLogoutListener();

      // When a staff token refresh fails mid-session (idle past the refresh
      // TTL, session revoked), api-client wipes the stored tokens and calls
      // this handler — clearing the in-memory user makes the root layout
      // redirect to the login screen instead of stranding the user on a
      // screen whose every request 401s (mirrors the buyer-side handler).
      registerStaffSessionExpiredHandler(() => {
        // D1: the session-expired path is the other caller of the shared
        // teardown (cause-ruling.md §3). Fire-and-forget with its own catch —
        // this callback's signature is synchronous and a teardown failure
        // must never block the redirect to /login below.
        teardownUserSession({
          reason: "session-expired",
          userId: get().user?.id ?? null,
        }).catch(() => {});
        useAuthStore.setState({ user: null, isAuthenticated: false, activeRole: null });
      });
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
    // The other tab signed out. Run the SAME shared teardown D1 defined
    // (cause-ruling.md §3) — GPS/query-cache/user-scoped stores in THIS tab
    // are otherwise left exactly as B150/B140 originally found them, because
    // this listener used to only clear the in-memory user — then drop it
    // without calling apiLogout() — the server already received the original
    // logout from the tab that signed out.
    teardownUserSession({
      reason: "cross-tab",
      userId: useAuthStore.getState().user?.id ?? null,
    }).catch(() => {});
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      activeRole: null,
    });
  });
}
