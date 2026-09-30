"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@routeflow/ui/web";

// ─── ReadOnlyBanner (RO-1) ───────────────────────────────────────────────────
// Shared read-only-workspace notice — the billing page's full-width card version and the
// dashboard shell's compact persistent slot (next to ImpersonationBanner) both render this.
// Mirrors TrialBanner's markup/styling (settings/billing/page.tsx) at the same visual weight.

export interface ReadOnlyBannerProps {
  status: string;
  readOnlyReason?: string | null;
  /** Condensed single-line variant for the dashboard-wide banner slot. */
  compact?: boolean;
}

const REASON_COPY: Record<string, string> = {
  trial_expired: "Your trial ended. Exports still work; subscribe to restore full access.",
  subscription_cancelled:
    "Your subscription ended. Exports still work; subscribe to restore full access.",
  trial_cancelled: "You ended your trial. Exports still work; subscribe to restore full access.",
};

/** trial_expired's copy, minus its first sentence — used for an unknown/absent reason. */
const DEFAULT_COPY = "Exports still work; subscribe to restore full access.";

export function ReadOnlyBanner({ status, readOnlyReason, compact = false }: ReadOnlyBannerProps) {
  if (status !== "READ_ONLY") return null;
  const body = (readOnlyReason && REASON_COPY[readOnlyReason]) || DEFAULT_COPY;

  return (
    <div
      className={cn(
        "flex items-center gap-2 bg-amber-50 text-amber-800 ring-1 ring-amber-200",
        compact ? "px-4 py-2 text-sm" : "rounded-lg px-4 py-3 text-sm",
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <strong>Your workspace is read-only.</strong> {body}{" "}
        <a href="/choose-plan" className="font-medium underline underline-offset-2">
          Choose a plan
        </a>
      </span>
    </div>
  );
}
