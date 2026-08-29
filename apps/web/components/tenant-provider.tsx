"use client";

import * as React from "react";
import { getSessionTenantSlug } from "@/lib/auth";
import { setTenantCookie } from "@/lib/tenant-cookie";
import { subscribeImpersonation } from "@/lib/impersonation";

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

/**
 * The session (JWT) wins over the cookie. A disagreeing cookie is stale —
 * self-heal it so it never brands the app as another tenant, and so it stops
 * feeding the wrong X-Tenant-Slug header on subsequent API calls.
 * Safe during SSR: getSessionTenantSlug/getTenantSlugFromCookie both guard
 * their respective globals, so jwtSlug is null and setTenantCookie is never
 * reached when window/document are undefined.
 */
function resolveTenantSlug(): string | null {
  const jwtSlug = getSessionTenantSlug();
  const cookieSlug = getTenantSlugFromCookie();
  if (jwtSlug && cookieSlug !== jwtSlug) {
    // Self-heal: a stale cookie must not brand the app as another tenant,
    // and it also feeds the X-Tenant-Slug header on every API call.
    setTenantCookie(jwtSlug);
  }
  return jwtSlug ?? cookieSlug;
}

const DEFAULT_PRIMARY = "#14a39f"; // Ledger --brand-500 (teal operator default)

/** Convert a #rrggbb hex string to "r, g, b" for CSS rgba() */
function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return isNaN(r) ? "20, 163, 159" : `${r}, ${g}, ${b}`;
}

/**
 * Mix a hex color toward black (amount < 0) or white (amount > 0) by |amount|.
 * Used to derive the accent ramp (strong/deep/soft) from a tenant's brand color
 * so primary buttons, stat tiles, and links re-brand together.
 */
function shade(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const ch = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)].map((h) => parseInt(h, 16));
  if (ch.some((n) => isNaN(n))) return hex;
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return (
    "#" +
    ch
      .map((c) =>
        Math.round(c + (target - c) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/**
 * Fetches the tenant's branding from the public API and injects it as CSS
 * custom properties on <html>.  Wrap this around Providers in layout.tsx.
 */
export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = React.useState<TenantBranding | null>(null);
  const [slug, setSlug] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  // Mirrors `slug` for the focus/visibility recheck below, which must compare
  // against the LATEST resolved slug even though the effect that calls it only
  // ever closes over the mount-time fetchBranding (see the empty-deps effect).
  const slugRef = React.useRef<string | null>(null);

  // Wrapped in useCallback so the Settings page (or any caller) can invoke
  // `refresh()` after a logo / colour change to re-pull the branding without
  // a hard page reload.
  const fetchBranding = React.useCallback(async () => {
    // Re-resolve on every call (never short-circuit on the stale `slug`
    // state) so a re-check after a tenant switch refetches the NEW tenant's
    // branding and re-applies its CSS vars.
    const tenantSlug = resolveTenantSlug();
    if (!tenantSlug) return;
    slugRef.current = tenantSlug;
    if (tenantSlug !== slug) setSlug(tenantSlug);
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
      // Only a custom brand overrides the accent ramp; without one, the exact
      // Ledger teal ramp (--primary-strong/deep/soft in globals.css) stands.
      // The accent ramp (--accent-strong/deep/soft) references --primary-strong/…,
      // so setting these re-brands the primary button, stat tiles, and links
      // together with the DEFAULT accent (which drives the focus ring).
      if (data.primaryColor) {
        root.style.setProperty("--primary-strong", shade(primary, -0.14));
        root.style.setProperty("--primary-deep", shade(primary, -0.28));
        root.style.setProperty("--primary-soft", shade(primary, 0.9));
      }
    } catch {
      // Branding fetch failure is non-fatal; app works without it
    } finally {
      setIsLoading(false);
    }
  }, [slug]);

  React.useEffect(() => {
    void fetchBranding();
    // Re-check on tab focus / visibility so a multi-tab impersonation switch
    // (localStorage/cookie changed underneath a mounted app) picks up the new
    // tenant's branding without requiring a hard reload. The impersonation
    // subscription covers the same-tab case — set/clear during a soft nav,
    // with no focus/visibility event to trigger a recheck. Only refetches
    // when the resolved slug actually changed — never on every focus event.
    const recheck = () => {
      const next = resolveTenantSlug();
      if (next && next !== slugRef.current) void fetchBranding();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    const unsubImp = subscribeImpersonation(recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      unsubImp();
    };
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
