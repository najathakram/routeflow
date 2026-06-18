"use client";

import * as React from "react";

export interface TenantBranding {
  slug: string;
  businessName: string;
  primaryColor: string | null;
  logoKey: string | null;
  logoUrl: string | null;
}

interface TenantContextValue {
  branding: TenantBranding | null;
  slug: string | null;
  isLoading: boolean;
  /** Re-fetch branding from the API (call after a logo / colour change). */
  refresh: () => Promise<void>;
}

const TenantContext = React.createContext<TenantContextValue>({
  branding: null,
  slug: null,
  isLoading: false,
  refresh: async () => {},
});

/** Read the tenant-slug cookie set by middleware or the login form. */
function getTenantSlugFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const DEFAULT_PRIMARY = "#2563eb"; // brand-600

/** Convert a #rrggbb hex string to "r, g, b" for CSS rgba() */
function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return isNaN(r) ? "37, 99, 235" : `${r}, ${g}, ${b}`;
}

/**
 * Fetches the tenant's branding from the public API and injects it as CSS
 * custom properties on <html>.  Wrap this around Providers in layout.tsx.
 */
export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = React.useState<TenantBranding | null>(null);
  const [slug, setSlug] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  // Wrapped in useCallback so the Settings page (or any caller) can invoke
  // `refresh()` after a logo / colour change to re-pull the branding without
  // a hard page reload.
  const fetchBranding = React.useCallback(async () => {
    const tenantSlug = slug ?? getTenantSlugFromCookie();
    if (!tenantSlug) return;
    if (!slug) setSlug(tenantSlug);
    setIsLoading(true);
    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";
      const res = await fetch(
        `${apiBase}/public/tenants/${encodeURIComponent(tenantSlug)}/branding`,
        // Bust the browser cache so a freshly uploaded logo shows up immediately.
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data: TenantBranding | null = await res.json();
      if (!data) return;

      setBranding(data);
      // Apply CSS variables to <html> so Tailwind + any component can use them
      const root = document.documentElement;
      const primary = data.primaryColor ?? DEFAULT_PRIMARY;
      root.style.setProperty("--primary", primary);
      root.style.setProperty("--primary-foreground", "#ffffff");
      // RGB breakdown for rgba() tinting e.g. rgba(var(--primary-rgb), 0.1)
      root.style.setProperty("--primary-rgb", hexToRgb(primary));
    } catch {
      // Branding fetch failure is non-fatal; app works without it
    } finally {
      setIsLoading(false);
    }
  }, [slug]);

  React.useEffect(() => {
    void fetchBranding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TenantContext.Provider value={{ branding, slug, isLoading, refresh: fetchBranding }}>
      {children}
    </TenantContext.Provider>
  );
}

/** Access the current tenant's branding anywhere in the tree. */
export function useTenant() {
  return React.useContext(TenantContext);
}
