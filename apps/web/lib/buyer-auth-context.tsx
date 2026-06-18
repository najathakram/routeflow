"use client";

import * as React from "react";
import {
  type BuyerUser,
  type BuyerSeller,
  getStoredBuyer,
  getStoredActiveSeller,
  storeActiveSeller,
  clearActiveSeller,
  buyerLogin,
  buyerRegister,
  buyerLogout,
  buyerRefreshTokens,
  getBuyerSellers,
} from "./buyer-auth";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BuyerAuthContextValue {
  buyer: BuyerUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  activeSeller: BuyerSeller | null;
  sellers: BuyerSeller[];
  login: (email: string, password: string) => Promise<BuyerUser>;
  register: (email: string, password: string, name: string) => Promise<BuyerUser>;
  logout: () => Promise<void>;
  setActiveSeller: (seller: BuyerSeller) => void;
  refreshSellers: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const BuyerAuthContext = React.createContext<BuyerAuthContextValue | null>(null);

export function BuyerAuthProvider({ children }: { children: React.ReactNode }) {
  const [buyer, setBuyer] = React.useState<BuyerUser | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [activeSeller, setActiveSellerState] = React.useState<BuyerSeller | null>(null);
  const [sellers, setSellers] = React.useState<BuyerSeller[]>([]);

  // On mount: restore session from stored token (or try refresh)
  React.useEffect(() => {
    const stored = getStoredBuyer();
    const storedSeller = getStoredActiveSeller();
    if (stored) {
      setBuyer(stored);
      setActiveSellerState(storedSeller);
      // Refresh sellers list in background
      const token = typeof window !== "undefined" ? localStorage.getItem("buyerAccessToken") : null;
      if (token) {
        getBuyerSellers(token)
          .then(setSellers)
          .catch((err) => console.warn("[BuyerAuth] Failed to load sellers:", err?.message));
      }
      setIsLoading(false);
    } else {
      buyerRefreshTokens()
        .then((data) => {
          if (data) {
            setBuyer(data.buyer);
            setActiveSellerState(getStoredActiveSeller());
            const token =
              typeof window !== "undefined" ? localStorage.getItem("buyerAccessToken") : null;
            if (token) {
              getBuyerSellers(token)
                .then(setSellers)
                .catch((err) => console.warn("[BuyerAuth] Failed to load sellers:", err?.message));
            }
          }
        })
        .finally(() => setIsLoading(false));
    }
  }, []);

  const login = React.useCallback(async (email: string, password: string): Promise<BuyerUser> => {
    const data = await buyerLogin(email, password);
    setBuyer(data.buyer);
    const token = typeof window !== "undefined" ? localStorage.getItem("buyerAccessToken") : null;
    if (token) {
      const list = await getBuyerSellers(token);
      setSellers(list);
    }
    return data.buyer;
  }, []);

  const register = React.useCallback(
    async (email: string, password: string, name: string): Promise<BuyerUser> => {
      const data = await buyerRegister(email, password, name);
      setBuyer(data.buyer);
      setSellers([]);
      return data.buyer;
    },
    [],
  );

  const logout = React.useCallback(async () => {
    await buyerLogout();
    setBuyer(null);
    setActiveSellerState(null);
    setSellers([]);
    if (typeof window !== "undefined") window.location.href = "/buyer/login";
  }, []);

  const setActiveSeller = React.useCallback((seller: BuyerSeller) => {
    storeActiveSeller(seller);
    setActiveSellerState(seller);
  }, []);

  const refreshSellers = React.useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("buyerAccessToken") : null;
    if (!token) return;
    const list = await getBuyerSellers(token);
    setSellers(list);
  }, []);

  return (
    <BuyerAuthContext.Provider
      value={{
        buyer,
        isLoading,
        isAuthenticated: buyer !== null,
        activeSeller,
        sellers,
        login,
        register,
        logout,
        setActiveSeller,
        refreshSellers,
      }}
    >
      {children}
    </BuyerAuthContext.Provider>
  );
}

export function useBuyerAuth(): BuyerAuthContextValue {
  const ctx = React.useContext(BuyerAuthContext);
  if (!ctx) throw new Error("useBuyerAuth must be used within BuyerAuthProvider");
  return ctx;
}
