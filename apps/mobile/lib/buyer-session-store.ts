import { create } from "zustand";
import { Platform } from "react-native";
import {
  getStoredBuyer,
  getActiveSeller,
  setActiveSeller as persistActiveSeller,
  buyerLogout,
  registerBuyerSessionExpiredHandler,
  type BuyerUser,
  type BuyerSeller,
} from "./buyer-auth";
import { BUYER_KEYS } from "./auth-keys";
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
    // REG-B204: this was the ONE boot store whose initialize had no catch, and
    // the root layout's `bootstrapping` gate ANDs over all three — so a
    // storage failure here (on device, SecureStore rejecting our colon
    // -namespaced keys) left the app on the splash spinner forever. A failed
    // read must resolve to "signed out", never to an eternal gate.
    try {
      const [buyer, seller] = await Promise.all([getStoredBuyer(), getActiveSeller()]);
      set({ buyer, activeSeller: seller });
    } catch {
      set({ buyer: null, activeSeller: null });
    } finally {
      set({ isLoading: false });
    }
    // BUG-B1-1: when buyer-auth's 401 retry fails it clears tokens; mirror
    // that into in-memory state so the layout redirect-to-login fires.
    registerBuyerSessionExpiredHandler(() => {
      useCartStore.getState().clear();
      set({ buyer: null, activeSeller: null });
    });
    // BUG-XR1-3: cross-tab buyer logout. When another tab clears the buyer
    // token, mirror the sign-out so this tab redirects to /customer-login.
    installBuyerCrossTabLogoutListener(() => {
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

let buyerCrossTabInstalled = false;
function installBuyerCrossTabLogoutListener(onLogout: () => void) {
  if (Platform.OS !== "web") return;
  if (buyerCrossTabInstalled) return;
  if (typeof window === "undefined") return;
  buyerCrossTabInstalled = true;
  const KEYS = new Set<string>([BUYER_KEYS.accessToken, BUYER_KEYS.activeSeller]);
  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key || e.newValue !== null) return;
    if (!KEYS.has(e.key)) return;
    onLogout();
  });
}
