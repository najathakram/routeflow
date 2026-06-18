"use client";

import * as React from "react";
import {
  type AuthUser,
  getStoredUser,
  login as apiLogin,
  logout as apiLogout,
  refreshTokens,
  onCrossTabTokenChange,
} from "./auth";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { AuthUser };

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  // On mount: restore session from stored token (or try refresh)
  React.useEffect(() => {
    const stored = getStoredUser();
    if (stored) {
      setUser(stored);
      setIsLoading(false);
    } else {
      refreshTokens()
        .then((data) => {
          if (data) setUser(data.user);
        })
        .finally(() => setIsLoading(false));
    }
  }, []);

  React.useEffect(() => {
    return onCrossTabTokenChange(() => {
      // Don't punt the user to /login if they're on a public marketing route —
      // they may not even know they were ever signed in. Marketing pages are
      // public and should keep rendering regardless of token state.
      const MARKETING_ROUTES = new Set([
        "/",
        "/retailers",
        "/wholesalers",
        "/distributors",
        "/buyer",
        "/product",
        "/pricing",
        "/company",
        "/contact",
      ]);
      if (typeof window !== "undefined" && MARKETING_ROUTES.has(window.location.pathname)) {
        return;
      }
      window.location.href = "/login";
    });
  }, []);

  const login = React.useCallback(async (username: string, password: string): Promise<AuthUser> => {
    const data = await apiLogin(username, password);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = React.useCallback(async () => {
    setUser(null);
    await apiLogout(); // redirects to /login
  }, []);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated: user !== null, isLoading, user, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
