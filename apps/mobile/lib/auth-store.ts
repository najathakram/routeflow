import { create } from "zustand";
import {
  AuthUser,
  login as apiLogin,
  logout as apiLogout,
  getStoredUser,
  refreshTokens,
} from "./auth";

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  initialize: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (username, password) => {
    const response = await apiLogin(username, password);
    set({ user: response.user, isAuthenticated: true });
    return response.user;
  },

  logout: async () => {
    await apiLogout();
    set({ user: null, isAuthenticated: false });
  },

  setUser: (user) => set({ user, isAuthenticated: user !== null }),

  initialize: async () => {
    set({ isLoading: true });
    try {
      let user = await getStoredUser();
      if (!user) {
        const refreshed = await refreshTokens();
        user = refreshed?.user ?? null;
      }
      set({ user, isAuthenticated: user !== null });
    } catch {
      set({ user: null, isAuthenticated: false });
    } finally {
      set({ isLoading: false });
    }
  },
}));
