import { useSyncExternalStore } from "react";
import { BILLING_RETURN_PATHS, type CheckoutStart } from "@routeflow/types";

/**
 * SA-1139 R4/R5/R7: the one place the web decides between Stripe's hosted page and the embedded form.
 * The open secret lives in a tiny store so any mutation (billing page, payment-due banner) can show the
 * one panel mounted in the dashboard shell. The secret is held in memory only, never stored or logged,
 * and it is dropped on Back and on completion so a stale one is never reused.
 */

/**
 * SA-1154: the allowlist of addresses an embedded checkout may return to. It lives once in `@routeflow/types`
 * (`BILLING_RETURN_PATHS`); this is only the web's name for it. The path itself is the SERVER's (`start.returnPath`,
 * read from the Stripe session it created): the web checks it against this list and never works one out.
 */
export { BILLING_RETURN_PATHS as CHECKOUT_RETURN_PATHS };

const ALLOWED_RETURN_PATHS: readonly string[] = Object.values(BILLING_RETURN_PATHS);

export type EmbeddedCheckoutOpen = { clientSecret: string; returnPath: string };

let current: EmbeddedCheckoutOpen | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getEmbeddedCheckout(): EmbeddedCheckoutOpen | null {
  return current;
}

export function getEmbeddedCheckoutSecret(): string | null {
  return current?.clientSecret ?? null;
}

export function getEmbeddedCheckoutReturnPath(): string | null {
  return current?.returnPath ?? null;
}

/** The caller passes the path the server sent; there is no default. */
export function openEmbeddedCheckout(clientSecret: string, returnPath: string): void {
  current = { clientSecret, returnPath };
  emit();
}

export function closeEmbeddedCheckout(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useEmbeddedCheckout(): EmbeddedCheckoutOpen | null {
  return useSyncExternalStore(subscribe, getEmbeddedCheckout, () => null);
}

/** The publishable key, baked at web build time. Empty when it was not set. */
export function stripePublishableKey(): string {
  return (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "").trim();
}

/**
 * Runs inside a mutationFn so a failure takes the caller's normal error path: an embedded answer with no
 * publishable key, or whose `returnPath` is not an exact member of the allowlist, logs once and throws, and
 * nothing opens (no panel, no navigation, nothing charged: the form never mounts). Hosted answers pass through.
 */
export function assertCheckoutStartable(start: CheckoutStart): CheckoutStart {
  if (start.uiMode !== "embedded") return start;
  if (!stripePublishableKey()) {
    // eslint-disable-next-line no-console -- the one deliberate log when the build has no key (R7)
    console.error("Embedded checkout needs NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY at web build time.");
    throw new Error("EMBEDDED_CHECKOUT_KEY_MISSING");
  }
  if (typeof start.returnPath !== "string" || !ALLOWED_RETURN_PATHS.includes(start.returnPath)) {
    // eslint-disable-next-line no-console -- the one deliberate log when the server's return path is not allowed (SA-1154)
    console.error("Embedded checkout refused: the return path is not an allowed billing path.");
    throw new Error("EMBEDDED_CHECKOUT_RETURN_PATH_REFUSED");
  }
  return start;
}

/**
 * Follows a started checkout (already through `assertCheckoutStartable`): embedded opens the panel in place and
 * returns to the path the server sent; hosted hands the url to `leave` (today's redirect, behind each caller's own
 * guards, and Stripe's own `success_url` brings the person back).
 */
export function followCheckout(start: CheckoutStart, leave: (url: string) => void): void {
  if (start.uiMode === "embedded") {
    openEmbeddedCheckout(start.clientSecret, start.returnPath);
    return;
  }
  leave(start.checkoutUrl);
}
