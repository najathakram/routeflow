"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldAlert, X } from "lucide-react";
import { useRestrictionsSettings } from "@/lib/api/restrictions-settings";

/**
 * Hub banner shown only when the selling-restrictions master switch is known to
 * be OFF. Loading/error render nothing. Uses the plain settings GET (never the
 * throttled admin-only readiness sweep). Only admins get the action link.
 */
export function ReadinessBanner({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading, isError } = useRestrictionsSettings();
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed || isLoading || isError || !data || data.enabled !== false) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-navy"
    >
      <ShieldAlert className="h-5 w-5 flex-none text-warning" />
      <span className="min-w-0 flex-1">
        Staff orders and invoices aren&apos;t checked against selling restrictions. Portal limits
        still apply.
      </span>
      {isAdmin && (
        <Link
          href="/settings/restrictions"
          className="font-medium text-brand-600 hover:text-brand-700"
        >
          Review restrictions
        </Link>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="rounded p-1 text-navy/50 hover:text-navy"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
