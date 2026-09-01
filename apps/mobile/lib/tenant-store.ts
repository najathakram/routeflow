import { create } from "zustand";
import { Platform } from "react-native";
import { toSecureStoreKey } from "./secure-key";

// ─── Platform-safe storage ────────────────────────────────────────────────────

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(key);
  const { getItemAsync } = await import("expo-secure-store");
  return getItemAsync(toSecureStoreKey(key));
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(key, value);
    return;
  }
  const { setItemAsync } = await import("expo-secure-store");
  await setItemAsync(toSecureStoreKey(key), value);
}

async function storageDel(key: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.removeItem(key);
    return;
  }
  const { deleteItemAsync } = await import("expo-secure-store");
  await deleteItemAsync(toSecureStoreKey(key));
}

const STORAGE_KEY = "tenantSlug";

// ─── Branding type ────────────────────────────────────────────────────────────

export interface TenantBranding {
  slug: string;
  businessName: string;
  primaryColor: string | null;
  logoKey: string | null;
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface TenantState {
  slug: string | null;
  branding: TenantBranding | null;
  isLoading: boolean;
  /** Load persisted slug from storage on app start */
  initialize: () => Promise<void>;
  /** Validate slug with the public API and persist it */
  setSlug: (slug: string, branding: TenantBranding) => Promise<void>;
  /** Clear tenant (used on logout or company-code reset) */
  clear: () => Promise<void>;
}

export const useTenantStore = create<TenantState>((set) => ({
  slug: null,
  branding: null,
  isLoading: true,

  initialize: async () => {
    set({ isLoading: true });
    try {
      const slug = await storageGet(STORAGE_KEY);
      if (slug) {
        // Restore branding from storage (lightweight — just the slug is enough
        // for the X-Tenant-Slug header; branding is re-fetched lazily)
        set({ slug, branding: null });
      }
    } catch {
      // Storage failure is non-fatal
    } finally {
      set({ isLoading: false });
    }
  },

  setSlug: async (slug, branding) => {
    await storageSet(STORAGE_KEY, slug);
    set({ slug, branding });
  },

  clear: async () => {
    await storageDel(STORAGE_KEY);
    set({ slug: null, branding: null });
  },
}));
