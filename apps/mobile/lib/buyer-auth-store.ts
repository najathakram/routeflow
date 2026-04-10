import { create } from "zustand";
import {
  BuyerUser,
  BuyerSeller,
  buyerLogin as apiBuyerLogin,
  buyerRegister as apiBuyerRegister,
  buyerLogout as apiBuyerLogout,
  buyerRefreshTokens,
  getStoredBuyer,
  getBuyerSellers,
  getActiveSeller,
  setActiveSeller as apiSetActiveSeller,
} from "./buyer-auth";

interface BuyerAuthState {
  buyer: BuyerUser | null;
  isBuyerAuthenticated: boolean;
  isLoading: boolean;
  sellers: BuyerSeller[];
  activeSeller: BuyerSeller | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => Promise<void>;
  fetchSellers: () => Promise<void>;
  setActiveSeller: (seller: BuyerSeller) => void;
}

export const useBuyerAuthStore = create<BuyerAuthState>((set) => ({
  buyer: null,
  isBuyerAuthenticated: false,
  isLoading: true,
  sellers: [],
  activeSeller: null,

  login: async (email, password) => {
    const response = await apiBuyerLogin(email, password);
    set({ buyer: response.buyer, isBuyerAuthenticated: true });
  },

  register: async (email, password, name) => {
    const response = await apiBuyerRegister(email, password, name);
    set({ buyer: response.buyer, isBuyerAuthenticated: true });
  },

  logout: async () => {
    await apiBuyerLogout();
    set({
      buyer: null,
      isBuyerAuthenticated: false,
      sellers: [],
      activeSeller: null,
    });
  },

  initialize: async () => {
    set({ isLoading: true });
    try {
      let buyer = await getStoredBuyer();
      if (!buyer) {
        const refreshed = await buyerRefreshTokens();
        buyer = refreshed?.buyer ?? null;
      }
      const activeSeller = await getActiveSeller();
      set({
        buyer,
        isBuyerAuthenticated: buyer !== null,
        activeSeller,
      });
    } catch {
      set({ buyer: null, isBuyerAuthenticated: false, activeSeller: null });
    } finally {
      set({ isLoading: false });
    }
  },

  fetchSellers: async () => {
    try {
      const sellers = await getBuyerSellers();
      set({ sellers });
    } catch {
      set({ sellers: [] });
    }
  },

  setActiveSeller: (seller) => {
    apiSetActiveSeller(seller).catch(() => {
      // Best-effort persist; state is updated immediately
    });
    set({ activeSeller: seller });
  },
}));
