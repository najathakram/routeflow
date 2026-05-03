import { create } from "zustand";
import {
  getStoredBuyer,
  getActiveSeller,
  setActiveSeller as persistActiveSeller,
  buyerLogout,
  registerBuyerSessionExpiredHandler,
  type BuyerUser,
  type BuyerSeller,
} from "./buyer-auth";
// RF-013: import cart store so we can clear it on logout
import { useCartStore } from "../store/cartStore";

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
    // BUG-B1-1: when buyer-auth's 401 retry fails it clears tokens; mirror
    // that into in-memory state so the layout redirect-to-login fires.
    registerBuyerSessionExpiredHandler(() => {
      useCartStore.getState().clear();
      set({ buyer: null, activeSeller: null });
    });
  },

  setBuyer: (buyer) => set({ buyer }),

  setActiveSeller: async (seller) => {
    await persistActiveSeller(seller);
    set({ activeSeller: seller });
  },

  signOut: async () => {
    await buyerLogout();
    // RF-013: clear local cart so next buyer session starts empty
    useCartStore.getState().clear();
    set({ buyer: null, activeSeller: null });
  },
}));
