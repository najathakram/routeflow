"use client";

import * as React from "react";
import { useTenant } from "./tenant-provider";

interface TenantLogoProps {
  /** Tailwind class for width/height, e.g. "h-8 w-8" */
  className?: string;
  /** Alt text fallback */
  alt?: string;
  /** Show business name next to the logo */
  showName?: boolean;
  nameClassName?: string;
  /** Fallback when tenant has no logo */
  fallback?: "seller" | "buyer";
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
  fallback = "seller",
}: TenantLogoProps) {
  const { branding } = useTenant();

  const logoSrc = branding?.logoUrl ?? (fallback === "buyer" ? "/logo-buyer.svg" : "/logo.svg");
  const displayName = branding?.businessName ?? "RouteFlow";
  const imgAlt = alt ?? displayName;

  return (
    <>
      <img
        src={logoSrc}
        alt={imgAlt}
        className={`${className} shrink-0 rounded-lg object-contain`}
      />
      {showName && <span className={nameClassName}>{displayName}</span>}
    </>
  );
}
