"use client";

import * as React from "react";
import Link from "next/link";
import { hasAnyAppLink, useAppLinks } from "@/lib/api/app-links";
import { isInShell } from "@/lib/in-shell";

/** localStorage key: dismissal is remembered per device. */
export const GET_THE_APP_DISMISSED_KEY = "rf:get-the-app:dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(GET_THE_APP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Row 559: a one-line nudge to install the app, in the dashboard's top strip slot (same shape as
 * `DriverAppBanner`). Only when an install link is ready, outside the app shell, not dismissed,
 * and never for a DRIVER (drivers already get the driver-app banner; one strip at a time).
 */
export function GetTheAppStrip({ isDriver }: { isDriver: boolean }) {
  const { data: links } = useAppLinks();
  // Read after mount so SSR and the first client paint agree (the shell mark and storage are client-only).
  const [ready, setReady] = React.useState(false);
  const [inShell, setInShell] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    setInShell(isInShell());
    setDismissed(readDismissed());
    setReady(true);
  }, []);

  if (!ready || isDriver || inShell || dismissed || !hasAnyAppLink(links)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(GET_THE_APP_DISMISSED_KEY, "1");
    } catch {
      /* blocked storage: hidden for this visit only */
    }
  };

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-raised px-4 py-2.5 text-sm text-navy"
    >
      <span>
        Get the RouteFlow app on your phone.{" "}
        <Link href="/get-the-app" className="font-medium text-[#0B6E6B] hover:underline">
          Get the app
        </Link>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="shrink-0 text-navy/50 hover:text-navy"
      >
        ✕
      </button>
    </div>
  );
}
