"use client";

import * as React from "react";
import { useTenant } from "./tenant-provider";

interface DocumentLetterheadProps {
  /** Optional tagline shown beneath the business name */
  tagline?: string;
}

/**
 * Consistent branded letterhead for printed documents (invoices, credit notes,
 * estimates). Shows the tenant's uploaded logo + business name when available;
 * falls back to the RouteFlow mark.
 */
export function DocumentLetterhead({ tagline }: DocumentLetterheadProps) {
  const { branding } = useTenant();
  const logoSrc = branding?.logoUrl ?? "/logo.svg";
  const name = branding?.businessName ?? "RouteFlow";

  return (
    <div>
      <div className="flex items-center gap-2">
        <img
          src={logoSrc}
          alt={name}
          className="h-10 w-10 shrink-0 rounded-lg object-contain"
        />
        <span className="text-lg font-bold text-navy">{name}</span>
      </div>
      {tagline && (
        <p className="mt-1 text-xs text-navy/50">{tagline}</p>
      )}
    </div>
  );
}
