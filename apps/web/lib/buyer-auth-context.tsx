"use client";

import * as React from "react";
import {
  type BuyerUser,
  type BuyerSeller,
  getBuyerAccessToken,
  getStoredBuyer,
  getStoredActiveSeller,
  storeActiveSeller,
  clearActiveSeller,
  buyerLogin,
  buyerRegister,
  buyerLogout,
  buyerRefreshTokens,
  getBuyerSellers,
  clearBuyerPresenceCookie,
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

  // Reconcile a restored activeSeller against the sellers list the server just
  // returned. B141: a seller that removed this buyer's customer record drops out
  // of GET /buyer/sellers, and keeping it active would 403 every guarded request
  // with nothing in the UI to explain it. Clearing it (state + the stored copy)
  // lets the portal pages' `!activeSeller` redirect send the buyer back to
  // /buyer/portal. A failed fetch never gets here, so it never clears anything.
  const applySellers = React.useCallback((list: BuyerSeller[], restored: BuyerSeller | null) => {
    setSellers(list);
    if (restored && !list.some((seller) => seller.linkId === restored.linkId)) {
      clearActiveSeller();
      setActiveSellerState(null);
    }
  }, []);

  // Mirror of `activeSeller` for the callbacks that reconcile a *later* fetch
  // (refreshSellers / login), so they can read the current one without taking a
  // dependency on it and re-identifying on every switch.
  const activeSellerRef = React.useRef<BuyerSeller | null>(null);
  React.useEffect(() => {
    activeSellerRef.current = activeSeller;
  }, [activeSeller]);

  // On mount: restore session from stored token (or try refresh)
  React.useEffect(() => {
    const stored = getStoredBuyer();
    const storedSeller = getStoredActiveSeller();
    if (stored) {
      setBuyer(stored);
      setActiveSellerState(storedSeller);
      // Refresh sellers list in background. A5: read through the canonical
      // accessor — the legacy "buyerAccessToken" literal is only written by
      // the Google callback, so password logins never populated sellers here.
      const token = getBuyerAccessToken();
      if (token) {
        getBuyerSellers(token)
          .then((list) => applySellers(list, storedSeller))
          .catch((err) => console.warn("[BuyerAuth] Failed to load sellers:", err?.message));
      }
      setIsLoading(false);
    } else {
      buyerRefreshTokens()
        .then((data) => {
          if (data) {
            setBuyer(data.buyer);
            const refreshedSeller = getStoredActiveSeller();
            setActiveSellerState(refreshedSeller);
            const token = getBuyerAccessToken();
            if (token) {
              getBuyerSellers(token)
                .then((list) => applySellers(list, refreshedSeller))
                .catch((err) => console.warn("[BuyerAuth] Failed to load sellers:", err?.message));
            }
          } else {
            // No restorable buyer session → drop the stale presence cookie so
            // the landing page stops auto-redirecting to the portal.
            clearBuyerPresenceCookie();
          }
        })
        .finally(() => setIsLoading(false));
    }
  }, [applySellers]);

  const login = React.useCallback(
    async (email: string, password: string): Promise<BuyerUser> => {
      const data = await buyerLogin(email, password);
      setBuyer(data.buyer);
      const token = getBuyerAccessToken();
      if (token) {
        const list = await getBuyerSellers(token);
        applySellers(list, activeSellerRef.current);
      }
      return data.buyer;
    },
    [applySellers],
  );

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
    const token = getBuyerAccessToken();
    if (!token) return;
    const list = await getBuyerSellers(token);
    // Same reconcile as the mount paths: a seller removed while the tab was open
    // must not stay active, or a Back into its pages 403s with no redirect.
    applySellers(list, activeSellerRef.current);
  }, [applySellers]);

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
