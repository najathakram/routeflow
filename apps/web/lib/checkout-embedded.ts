import { useSyncExternalStore } from "react";
import type { CheckoutStart } from "@routeflow/types";

/**
 * SA-1139 R4/R5/R7: the one place the web decides between Stripe's hosted page and the embedded form.
 * The open secret lives in a tiny store so any mutation (billing page, payment-due banner) can show the
 * one panel mounted in the dashboard shell. The secret is held in memory only, never stored or logged,
 * and it is dropped on Back and on completion so a stale one is never reused.
 */

let secret: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getEmbeddedCheckoutSecret(): string | null {
  return secret;
}

export function openEmbeddedCheckout(clientSecret: string): void {
  secret = clientSecret;
  emit();
}

export function closeEmbeddedCheckout(): void {
  if (secret === null) return;
  secret = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useEmbeddedCheckoutSecret(): string | null {
  return useSyncExternalStore(subscribe, getEmbeddedCheckoutSecret, () => null);
}

/** The publishable key, baked at web build time. Empty when it was not set. */
export function stripePublishableKey(): string {
  return (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "").trim();
}

/**
 * Runs inside a mutationFn so a failure takes the caller's normal error path: an embedded answer with no
 * publishable key logs once and throws, and nothing opens. Hosted answers pass through untouched.
 */
export function assertCheckoutStartable(start: CheckoutStart): CheckoutStart {
  if (start.uiMode === "embedded" && !stripePublishableKey()) {
    // eslint-disable-next-line no-console -- the one deliberate log when the build has no key (R7)
    console.error("Embedded checkout needs NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY at web build time.");
    throw new Error("EMBEDDED_CHECKOUT_KEY_MISSING");
  }
  return start;
}

/**
 * Follows a started checkout: embedded opens the panel in place; hosted hands the url to `leave`
 * (today's redirect, behind each caller's own guards).
 */
export function followCheckout(start: CheckoutStart, leave: (url: string) => void): void {
  if (start.uiMode === "embedded") {
    openEmbeddedCheckout(start.clientSecret);
    return;
  }
  leave(start.checkoutUrl);
}
