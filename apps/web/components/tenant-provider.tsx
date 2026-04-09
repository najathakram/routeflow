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
}

const TenantContext = React.createContext<TenantContextValue>({
  branding: null,
  slug: null,
  isLoading: false,
});

/** Read the tenant-slug cookie set by middleware (or a manual dev override). */
function getTenantSlugFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const DEFAULT_PRIMARY = "#3B82F6"; // Tailwind blue-500

/**
 * Fetches the tenant's branding from the public API and injects it as CSS
 * custom properties on <html>.  Wrap this around Providers in layout.tsx.
 */
export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = React.useState<TenantBranding | null>(null);
  const [slug, setSlug] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  React.useEffect(() => {
    const tenantSlug = getTenantSlugFromCookie();
    if (!tenantSlug) return;

    setSlug(tenantSlug);
    setIsLoading(true);

    const apiBase =
      process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

    fetch(`${apiBase}/public/tenants/${encodeURIComponent(tenantSlug)}/branding`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TenantBranding | null) => {
        if (!data) return;

        setBranding(data);

        // Apply CSS variables to <html> so Tailwind + any component can use them
        const root = document.documentElement;
        const primary = data.primaryColor ?? DEFAULT_PRIMARY;
        root.style.setProperty("--primary", primary);
        root.style.setProperty("--primary-foreground", "#ffffff");

        // Update tab title
        document.title = data.businessName;
      })
      .catch(() => {
        // Branding fetch failure is non-fatal; app works without it
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <TenantContext.Provider value={{ branding, slug, isLoading }}>
      {children}
    </TenantContext.Provider>
  );
}

/** Access the current tenant's branding anywhere in the tree. */
export function useTenant() {
  return React.useContext(TenantContext);
}
