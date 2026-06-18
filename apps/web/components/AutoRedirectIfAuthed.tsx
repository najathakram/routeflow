"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { OP_KEYS, BUYER_KEYS } from "@/lib/auth-keys";

/**
 * Client-side guard for the marketing landing page (`/`). If the visitor
 * already has a valid-looking session token in localStorage, send them
 * straight to their dashboard so they don't have to click Sign In every
 * time they type the bare domain.
 *
 * Priority:
 *   1. Operator session → /dashboard
 *   2. Buyer session    → /buyer/portal/{activeSeller}/dashboard if a
 *                         seller has been picked, otherwise /buyer/portal
 *                         (which renders the seller-picker).
 *
 * Renders a translucent splash overlay while checking — keeps the
 * marketing copy from flashing for half a second before the redirect
 * fires. The check itself is synchronous (just localStorage reads), so
 * the overlay is on screen for one paint at most.
 */
interface Props {
  /**
   * When true, the redirect is skipped — used by the landing page if the
   * visitor explicitly clicked "Back to home" while logged in (so we don't
   * trap them in a redirect loop).
   */
  disabled?: boolean;
}

export function AutoRedirectIfAuthed({ disabled }: Props) {
  const router = useRouter();
  // Start in the "checking" state so we render the splash on first paint.
  // Switched to "decided" when the effect runs (post-mount) regardless of
  // whether we redirect — that way SSR markup matches the first client
  // render and we avoid a hydration mismatch on the splash overlay.
  const [decided, setDecided] = React.useState(false);

  React.useEffect(() => {
    if (disabled) {
      setDecided(true);
      return;
    }
    try {
      const opToken = window.localStorage.getItem(OP_KEYS.accessToken);
      if (opToken && opToken.length > 10) {
        router.replace("/dashboard");
        return;
      }
      const buyerToken = window.localStorage.getItem(BUYER_KEYS.accessToken);
      if (buyerToken && buyerToken.length > 10) {
        const activeSellerRaw = window.localStorage.getItem(BUYER_KEYS.activeSeller);
        let sellerSlug: string | null = null;
        if (activeSellerRaw) {
          try {
            const parsed = JSON.parse(activeSellerRaw);
            if (parsed && typeof parsed === "object" && typeof parsed.slug === "string") {
              sellerSlug = parsed.slug;
            } else if (typeof parsed === "string") {
              sellerSlug = parsed;
            }
          } catch {
            // Stored as a plain string in older clients
            sellerSlug = activeSellerRaw;
          }
        }
        router.replace(sellerSlug ? `/buyer/portal/${sellerSlug}/dashboard` : "/buyer/portal");
        return;
      }
    } catch {
      // localStorage unavailable (private mode, SSR, etc.) — fall through and show landing.
    }
    setDecided(true);
  }, [router, disabled]);

  if (decided) return null;

  // Splash while we figure out where to send the user. Plain HTML
  // (no shadcn/Tailwind state-dependent classes) so it renders before
  // any of the heavy marketing components hydrate.
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-white"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <p className="text-xs text-navy/70">Loading…</p>
      </div>
    </div>
  );
}
