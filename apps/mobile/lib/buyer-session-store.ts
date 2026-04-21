import { create } from "zustand";
import {
  getStoredBuyer,
  getActiveSeller,
  setActiveSeller as persistActiveSeller,
  buyerLogout,
  type BuyerUser,
  type BuyerSeller,
} from "./buyer-auth";

interface BuyerSessionState {
  buyer: BuyerUser | null;
  activeSeller: BuyerSeller | null;
  isLoading: boolean;
  initialize: () => Promise<void>;
  setBuyer: (buyer: BuyerUser | null) => void;
  setActiveSeller: (seller: BuyerSeller) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useBuyerSessionStore = create<BuyerSessionState>()((set) => ({
  buyer: null,
  activeSeller: null,
  isLoading: true,

  initialize: async () => {
    const [buyer, seller] = await Promise.all([getStoredBuyer(), getActiveSeller()]);
    set({ buyer, activeSeller: seller, isLoading: false });
  },

  setBuyer: (buyer) => set({ buyer }),

  setActiveSeller: async (seller) => {
    await persistActiveSeller(seller);
    set({ activeSeller: seller });
  },

  signOut: async () => {
    await buyerLogout();
    set({ buyer: null, activeSeller: null });
  },
}));
