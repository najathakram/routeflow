"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export interface User {
  id: string;
  name: string;
  role: "OPERATOR" | "DRIVER" | "ADMIN";
}

interface AuthContextValue {
  isAuthenticated: boolean;
  user: User;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

const MOCK_USER: User = { id: "1", name: "Maria Operator", role: "OPERATOR" };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const logout = React.useCallback(() => {
    router.push("/login");
  }, [router]);

  return (
    <AuthContext.Provider value={{ isAuthenticated: true, user: MOCK_USER, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
