"use client";

import * as React from "react";
import {
  type AuthUser,
  getStoredUser,
  login as apiLogin,
  logout as apiLogout,
  refreshTokens,
  onCrossTabTokenChange,
  clearOpPresenceCookie,
} from "./auth";
import { subscribeImpersonation } from "./impersonation";
import { MARKETING_PAGE_PATHS } from "./marketing-routes";

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
          // No restorable session → any lingering presence cookie is stale;
          // drop it so the landing page stops auto-redirecting.
          else clearOpPresenceCookie();
        })
        .finally(() => setIsLoading(false));
    }
  }, []);

  // Impersonation set/clear swaps the active token without a route change —
  // re-read the decoded identity so the header chip and role gates follow the
  // acting session. Only a NON-NULL read is applied: a null read (the stored
  // access token has simply aged out while the refresh token is still good)
  // must never tear down an established session — that would bounce an idle
  // tab to /login. Cross-tab sign-out is onCrossTabTokenChange's job below.
  // Do NOT fall back to refreshTokens() here either — a null read during the
  // transition must not re-pin the old session.
  React.useEffect(() => {
    return subscribeImpersonation(() => {
      const next = getStoredUser();
      if (next) setUser(next);
    });
  }, []);

  React.useEffect(() => {
    return onCrossTabTokenChange(() => {
      // Don't punt the user to /login if they're on a public marketing route —
      // they may not even know they were ever signed in. Marketing pages are
      // public and should keep rendering regardless of token state.
      const MARKETING_ROUTES = new Set<string>([...MARKETING_PAGE_PATHS, "/buyer"]);
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
