"use client";

import * as React from "react";
import { Zap } from "lucide-react";
import { cn, TAP_TARGET } from "@routeflow/ui/web";

/**
 * B1054: the "Generate order now" control on a standing-order row. While a generate request is in
 * flight the button is disabled (and busy), so a double click can no longer fire a second request.
 * The API answers a repeat press with the first order regardless; this is the client half.
 */
export interface GenerateOrderNowButtonProps {
  /** A generate request is in flight (the page shares one mutation across its rows). */
  pending: boolean;
  onGenerate: () => void;
}

export function GenerateOrderNowButton({ pending, onGenerate }: GenerateOrderNowButtonProps) {
  return (
    <button
      type="button"
      title="Generate order now"
      disabled={pending}
      aria-busy={pending}
      className={cn(
        TAP_TARGET,
        "rounded p-1.5 text-navy/70 transition-colors hover:bg-brand-50 hover:text-brand-600",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
      onClick={onGenerate}
    >
      <Zap className="h-4 w-4" />
    </button>
  );
}
