"use client";

import * as React from "react";
import { useTenant } from "./tenant-provider";
import { BrandMark, type BrandTone } from "./brand/BrandMark";

interface TenantLogoProps {
  /** Tailwind class for width/height, e.g. "h-8 w-8" */
  className?: string;
  /** Alt text fallback */
  alt?: string;
  /** Show business name next to the logo */
  showName?: boolean;
  nameClassName?: string;
  /**
   * Historically selected between separate buyer/seller logo files. Both now
   * fall back to the one shared brand mark (R4); kept for caller compatibility.
   */
  fallback?: "seller" | "buyer";
  /**
   * Surface tone for the fallback RouteFlow mark (no tenant logo uploaded).
   * `"light"` inverts the mark to white ink for dark surfaces (e.g. the
   * navy dashboard sidebar). Defaults to `"dark"`. The tenant's own
   * uploaded logo is unaffected. See fix-round-4 ruling H3.
   */
  tone?: BrandTone;
}

/**
 * Renders the tenant's uploaded logo if available; otherwise falls back to
 * the default RouteFlow mark.  Business name is sourced from tenant branding
 * when showName=true (falls back to "RouteFlow").
 */
export function TenantLogo({
  className = "h-8 w-8",
  alt,
  showName = false,
  nameClassName = "text-lg font-bold text-white",
  tone = "dark",
}: TenantLogoProps) {
  const { branding } = useTenant();

  const displayName = branding?.businessName ?? "RouteFlow";
  const imgAlt = alt ?? displayName;

  return (
    <>
      {branding?.logoUrl ? (
        <img
          src={branding.logoUrl}
          alt={imgAlt}
          className={`${className} shrink-0 rounded-lg object-contain`}
        />
      ) : (
        // BrandMark is alt=""/aria-hidden (decorative by design), so the
        // fallback carries the accessible name itself — otherwise the `alt`
        // prop would be silently dropped here (fix-round-5 ruling R4).
        <span role="img" aria-label={imgAlt} className="shrink-0">
          <BrandMark tone={tone} className={`${className} rounded-lg object-contain`} />
        </span>
      )}
      {showName && <span className={nameClassName}>{displayName}</span>}
    </>
  );
}
